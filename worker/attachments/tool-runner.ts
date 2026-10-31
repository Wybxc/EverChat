import { createHash } from 'node:crypto';
import {
  TEXT_READ_BYTES,
  TEXT_SCAN_BYTES,
  type AttachmentToolResult,
  type TextReference,
  type TextToolSource,
} from '../../shared/attachments/tools';
import { LiteralScanner, sampleTextRanges } from '../../shared/attachments/text-index';
import { estimateTextTokens } from '../../shared/conversation/token-estimate';
import type { WebToolCall, WebToolOutcome } from '../../shared/tools/tasks';
import type { SqlQuery } from '../generation/metrics';
import { TextReader } from './text-reader';

export const ATTACHMENT_TOOL_JOBS_SCHEMA = `CREATE TABLE IF NOT EXISTS attachment_tool_jobs (
  rootId TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(rootId,id)) WITHOUT ROWID`;
type AttachmentCall = Extract<
  WebToolCall,
  { name: 'attachment_info' | 'attachment_read' | 'attachment_search' }
>;
type Range = { start: number; end: number };
interface Job {
  ranges?: Range[];
  range: number;
  file: number;
  offset: number;
  counts: Record<string, number>;
  states: Record<string, number>;
  scanned: number;
  line?: { byte: number; line: number };
  complete?: WebToolOutcome;
  requestHash?: string;
  pageMatches?: AttachmentToolResult['matches'];
  pageFragments?: AttachmentToolResult['fragments'];
}
export type AttachmentToolStep =
  { pending: true; scannedBytes: number } | { pending: false; outcome: WebToolOutcome };
const blank = (): Job => ({ range: 0, file: 0, offset: 0, counts: {}, states: {}, scanned: 0 });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intersect = (ranges: Range[], allowed: Range[]) =>
  ranges
    .flatMap((r) =>
      allowed.flatMap((a) => {
        const start = Math.max(r.start, a.start),
          end = Math.min(r.end, a.end);
        return end > start ? [{ start, end }] : [];
      }),
    )
    .sort((a, b) => a.start - b.start)
    .reduce<Range[]>((result, r) => {
      const prev = result.at(-1);
      if (prev && prev.end >= r.start) prev.end = Math.max(prev.end, r.end);
      else result.push({ ...r });
      return result;
    }, []);

/** One bounded R2 batch per durable step. Cursors and checkpoints never contain source text. */
export class AttachmentToolRunner {
  constructor(
    private query: SqlQuery,
    private bucket: R2Bucket,
    private source: (file: TextReference) => Promise<TextToolSource>,
  ) {}
  private load(rootId: string, id: string, fingerprint: string) {
    const row = this.query<{ fingerprint: string; payload: string }>(
      'SELECT fingerprint,payload FROM attachment_tool_jobs WHERE rootId=? AND id=?',
      rootId,
      id,
    ).toArray()[0];
    if (row && row.fingerprint !== fingerprint)
      throw new Error('Cursor belongs to another file version, range or search');
    return row ? (JSON.parse(row.payload) as Job) : undefined;
  }
  private save(rootId: string, id: string, fingerprint: string, job: Job) {
    this.query(
      'INSERT INTO attachment_tool_jobs VALUES(?,?,?,?) ON CONFLICT(rootId,id) DO UPDATE SET payload=excluded.payload',
      rootId,
      id,
      fingerprint,
      JSON.stringify(job),
    );
  }
  async step(
    rootId: string,
    call: AttachmentCall,
    contextTokens: number,
  ): Promise<AttachmentToolStep> {
    const requested = 'maxTokens' in call.input ? call.input.maxTokens : 4096;
    const budget = Math.min(requested, contextTokens);
    if (budget < 512) throw new Error('Not enough remaining context for attachment output');
    const fingerprint = digest({
      name: call.name,
      ...Object.fromEntries(
        Object.entries(call.input).filter(
          ([key]) =>
            key !== 'cursor' &&
            key !== 'maxTokens' &&
            (call.name !== 'attachment_read' ||
              !['ranges', 'line', 'page', 'sample'].includes(key)),
        ),
      ),
    });
    let job = this.load(rootId, call.id, fingerprint);
    if (job?.requestHash && job.requestHash !== digest(call.input))
      throw new Error('Tool call ID was reused with different input');
    if (job?.complete) return { pending: false, outcome: job.complete };
    if (!job) {
      const cursor = 'cursor' in call.input ? call.input.cursor : undefined;
      if (cursor) {
        const previous = this.load(rootId, cursor, fingerprint);
        if (!previous) throw new Error('Cursor is expired or not authorized for this task');
        job = structuredClone(previous);
        delete job.complete;
      } else job = blank();
    }
    job.requestHash = digest(call.input);
    const result: AttachmentToolResult = {
      files: [],
      fragments: job.pageFragments ?? [],
      matches: job.pageMatches ?? [],
      counts: {},
      scannedBytes: job.scanned,
      scanComplete: true,
      matchesFound: 0,
      totalMatches: 0,
      hasMoreResults: false,
      hasMore: false,
      nextCursor: null,
      estimatedTokens: 0,
      truncatedReason: null,
    };
    const outputBytes = Math.min(TEXT_READ_BYTES, Math.max(4, Math.floor((budget - 512) / 2)));
    const metadata = (s: TextToolSource) => ({
      attachmentId: s.attachmentId,
      textSha256: s.textSha256,
      name: s.name,
      mediaType: s.mediaType,
      bytes: s.bytes,
      characters: s.characters,
      lines: s.lines,
      ranges: s.ranges,
      ...(s.pageOffsets ? { pages: s.pageOffsets.length - 1 } : {}),
    });
    let pending = false,
      more = false;
    if (call.name === 'attachment_info') {
      for (const file of call.input.files) result.files.push(metadata(await this.source(file)));
    } else if (call.name === 'attachment_read') {
      const source = await this.source(call.input.file),
        reader = new TextReader(this.bucket, source);
      if (!job.ranges) {
        if (call.input.line) {
          const position = await reader.linePosition(call.input.line, job.line);
          job.line = position;
          if (!position.found) pending = true;
          else job.ranges = intersect([{ start: position.byte, end: source.bytes }], source.ranges);
        } else if (call.input.page) {
          const pages = source.pageOffsets,
            page = call.input.page;
          if (!pages || page >= pages.length) throw new Error('PDF page is unavailable');
          job.ranges = intersect(
            [
              {
                start: await reader.byteAt(pages[page - 1]),
                end: await reader.byteAt(pages[page]),
              },
            ],
            source.ranges,
          );
        } else if (call.input.sample) {
          // Sample positions within each authorized interval, never across selection gaps.
          job.ranges = source.ranges.flatMap((r) =>
            sampleTextRanges(
              r.end - r.start,
              call.input.sample!.count,
              call.input.sample!.bytes,
            ).map((p) => ({ start: r.start + p.start, end: r.start + p.end })),
          );
        } else job.ranges = intersect(call.input.ranges ?? source.ranges, source.ranges);
        if (job.ranges) job.offset = job.ranges[0]?.start ?? 0;
      }
      if (!pending) {
        let remaining = outputBytes;
        while (job.range < job.ranges!.length && remaining > 0) {
          const range = job.ranges![job.range],
            start = Math.max(job.offset, range.start),
            end = Math.min(range.end, start + remaining);
          const fragment = await reader.fragment(start, end);
          if (fragment.end <= start) break;
          result.fragments.push(fragment);
          remaining -= fragment.end - start;
          job.offset = fragment.end;
          if (fragment.end >= range.end || end === range.end) {
            job.range++;
            job.offset = job.ranges![job.range]?.start ?? 0;
          }
        }
        more = job.range < job.ranges!.length;
      }
    } else {
      const input = call.input;
      if (job.file < input.files.length) {
        const source = await this.source(input.files[job.file]),
          reader = new TextReader(this.bucket, source);
        const ranges = intersect(input.range ? [input.range] : source.ranges, source.ranges);
        if (job.range < ranges.length) {
          const range = ranges[job.range],
            start = Math.max(job.offset, range.start),
            end = Math.min(range.end, start + TEXT_SCAN_BYTES);
          const counts = Object.fromEntries(
            input.patterns.map((p) => [p.id, job!.counts[`${source.attachmentId}:${p.id}`] ?? 0]),
          );
          const scanner = new LiteralScanner(input.patterns, counts, job.states);
          const maxMatches = Math.max(1, Math.min(64, Math.floor(outputBytes / 2048)));
          const data = await reader.bytes(start, end);
          const after = scanner.scan(
            data,
            start,
            (patternId, from, to) => {
              if (input.mode !== 'count')
                result.matches.push({
                  attachmentId: source.attachmentId,
                  textSha256: source.textSha256,
                  patternId,
                  start: from,
                  end: to,
                });
            },
            () => result.matches.length >= maxMatches,
          );
          const checkpoint = scanner.checkpoint();
          job.states = checkpoint.states;
          for (const p of input.patterns)
            job.counts[`${source.attachmentId}:${p.id}`] = checkpoint.counts[p.id];
          job.scanned += after - start;
          job.offset = after;
          if (after >= range.end) {
            job.range++;
            job.offset = 0;
            job.states = {};
          }
        }
        if (job.range >= ranges.length) {
          job.file++;
          job.range = 0;
          job.offset = 0;
          job.states = {};
        }
      }
      more = job.file < input.files.length;
      // A count or an empty positions page continues internally, without another model request.
      pending =
        more &&
        (input.mode === 'count' ||
          result.matches.length < Math.max(1, Math.min(64, Math.floor(outputBytes / 2048))));
      job.pageMatches = result.matches;
      job.pageFragments = result.fragments;
      result.counts = { ...job.counts };
      result.scannedBytes = job.scanned;
      result.scanComplete = !more;
      result.matchesFound = Object.values(job.counts).reduce((sum, count) => sum + count, 0);
      result.totalMatches = more ? null : result.matchesFound;
    }
    if (pending) {
      this.save(rootId, call.id, fingerprint, job);
      return { pending: true, scannedBytes: job.scanned };
    }
    if (call.name === 'attachment_search' && call.input.mode === 'snippets') {
      for (const ref of call.input.files) {
        const matches = result.matches.filter((m) => m.attachmentId === ref.attachmentId);
        if (!matches.length) continue;
        const source = await this.source(ref),
          reader = new TextReader(this.bucket, source);
        const snippets = intersect(
          matches.map((m) => ({
            start: Math.max(0, m.start - 128),
            end: Math.min(source.bytes, m.end + 128),
          })),
          source.ranges,
        );
        for (const r of snippets) result.fragments.push(await reader.fragment(r.start, r.end));
      }
    }
    result.hasMore = more;
    if (more) {
      const cursor = crypto.randomUUID();
      const next = { ...job };
      delete next.pageMatches;
      delete next.pageFragments;
      delete next.requestHash;
      this.save(rootId, cursor, fingerprint, next);
      result.nextCursor = cursor;
      result.truncatedReason = budget < requested ? 'context_budget' : 'output_budget';
    }
    result.estimatedTokens = estimateTextTokens(JSON.stringify(result));
    if (result.estimatedTokens > budget)
      throw new Error('Attachment result metadata exceeds the requested output budget');
    const outcome: WebToolOutcome = {
      id: call.id,
      name: call.name,
      status: 'completed',
      sources: [],
      attachment: result,
    };
    this.save(rootId, call.id, fingerprint, { ...job, complete: outcome });
    return { pending: false, outcome };
  }
}
