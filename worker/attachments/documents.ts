import { TextReader, textObjectMatches } from './text-reader';
import { indexText, TextIndexer, type TextIndex } from '../../shared/attachments/text-index';
import type { TextToolSource } from '../../shared/attachments/tools';
import { estimateTextTokens } from '../../shared/conversation/token-estimate';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import {
  DOCUMENT_VERSION,
  documentMediaTypeSchema,
  documentPartSchema,
  documentRangesSchema,
  documentSource,
  estimateDocumentTokens,
  MAX_DOCUMENT_BYTES,
  selectedDocumentText,
  type DocumentPart,
  type DocumentRange,
} from '../../shared/attachments/documents';
import type { Attachment } from '../../shared/attachments/files';
import { ATTACHMENT_LEASE } from '../../shared/attachments/files';
import {
  pdfExtractionSchema,
  validatePdfText,
  type PDFExtraction,
  type PDFMetadata,
} from '../../shared/attachments/pdf';
import { problem } from '../../shared/errors/descriptor';
import { HttpError } from '../http/response';
import { extractDocument } from './parser';
import { DocumentInputSnapshots } from './input-snapshots';
import type { InputEvidenceBackup } from '../../shared/streaming/input-receipt';

type Source = Attachment & { key: string };
type Row = {
  id: string;
  status: string;
  key: string;
  lease: number;
  token: string | null;
  sha256: string | null;
  characters: number;
  tokens: number;
  bytes: number;
  csv: string | null;
  error: string | null;
  errorStatus: number | null;
} & Record<string, SqlStorageValue>;
const digest = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const TEXT_INDEX_SCHEMA =
  'CREATE TABLE IF NOT EXISTS attachment_text_indexes (id TEXT PRIMARY KEY, key TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, lines INTEGER NOT NULL)';
export class DocumentStore {
  private parsing = new Map<string, Promise<DocumentPart>>();
  readonly inputSnapshots: DocumentInputSnapshots;
  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket | undefined,
    private source: (conversationId: string, id: string) => Source,
    private original: (conversationId: string, id: string, head?: boolean) => Promise<Response>,
    private settled: (id: string) => void,
  ) {
    storage.sql.exec(TEXT_INDEX_SCHEMA);
    this.inputSnapshots = new DocumentInputSnapshots(storage, bucket, (conversationId, id) =>
      this.requireSource(conversationId, id),
    );
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS attachment_documents (id TEXT PRIMARY KEY, status TEXT NOT NULL, key TEXT NOT NULL,
      lease INTEGER NOT NULL, token TEXT, sha256 TEXT, characters INTEGER NOT NULL, tokens INTEGER NOT NULL, bytes INTEGER NOT NULL,
      csv TEXT, error TEXT, errorStatus INTEGER)`);
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS attachment_pdf_metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    );
  }
  private pdfData(id: string): (PDFMetadata & { pageOffsets?: number[] }) | undefined {
    const row = this.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM attachment_pdf_metadata WHERE id = ?', id)
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private pdf(id: string): PDFMetadata | undefined {
    const value = this.pdfData(id);
    return value ? { pages: value.pages, parserVersion: value.parserVersion } : undefined;
  }
  private row(id: string) {
    return this.storage.sql
      .exec<Row>('SELECT * FROM attachment_documents WHERE id = ?', id)
      .toArray()[0];
  }
  private textIntegrity(conversationId: string, row: Row) {
    const source = this.requireSource(conversationId, row.id);
    return {
      bytes: row.bytes,
      sourceSha256: row.sha256!,
      validatedOriginal: row.key === source.key && row.sha256 === source.sha256,
    };
  }
  parsedReference(conversationId: string, id: string) {
    return this.row(id)?.status === 'ready' ? this.reference(conversationId, id) : undefined;
  }
  archiveReference(conversationId: string, id: string) {
    const reference = this.parsedReference(conversationId, id);
    const pageOffsets = this.pdfData(id)?.pageOffsets;
    return reference
      ? { reference, bytes: this.row(id)!.bytes, ...(pageOffsets ? { pageOffsets } : {}) }
      : undefined;
  }
  async contentResponse(conversationId: string, id: string) {
    this.reference(conversationId, id);
    const row = this.row(id)!;
    const object = await this.bucket!.get(row.key);
    this.requireSource(conversationId, id);
    if (!object || !textObjectMatches(object, this.textIntegrity(conversationId, row))) {
      await object?.body.cancel();
      throw new HttpError(409, '文件文本不可用或完整性校验失败。');
    }
    return new Response(object.body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment',
      },
    });
  }
  /** Explicit copies preserve canonical text, even if extraction policy changes later. */
  async cloneParsed(
    sourceConversation: string,
    id: string,
    targetConversation: string,
    targetId: string,
  ) {
    const file = this.reference(sourceConversation, id),
      row = this.row(id)!,
      target = this.requireSource(targetConversation, targetId);
    const response = await this.contentResponse(sourceConversation, id),
      key = `${target.key}/text-v1`;
    if (!response.body) throw new HttpError(409, '文件文本不存在。');
    await this.bucket!.put(key, response.body, {
      sha256: file.textSha256,
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
    const index = this.storage.sql
      .exec<{ key: string; sha256: string; bytes: number; lines: number }>(
        'SELECT * FROM attachment_text_indexes WHERE id=?',
        id,
      )
      .toArray()[0];
    if (!index) throw new HttpError(409, '文件索引缺失，请先执行离线维护。');
    const savedIndex = await this.bucket!.get(index.key);
    if (!savedIndex) throw new HttpError(409, '文件索引不存在。');
    const indexKey = `${target.key}/text-index-v1`;
    await this.bucket!.put(indexKey, savedIndex.body, {
      sha256: index.sha256,
      httpMetadata: { contentType: 'application/json' },
    });
    this.requireSource(sourceConversation, id);
    this.requireSource(targetConversation, targetId);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO attachment_documents VALUES (?, 'ready', ?, 0, NULL, ?, ?, ?, ?, ?, NULL, NULL)",
        targetId,
        key,
        row.sha256,
        row.characters,
        row.tokens,
        row.bytes,
        row.csv,
      );
      this.storage.sql.exec(
        'INSERT INTO attachment_text_indexes VALUES(?,?,?,?,?)',
        targetId,
        indexKey,
        index.sha256,
        index.bytes,
        index.lines,
      );
      const pdf = this.pdfData(id);
      if (pdf)
        this.storage.sql.exec(
          'INSERT INTO attachment_pdf_metadata VALUES(?,?)',
          targetId,
          JSON.stringify(pdf),
        );
    });
    return this.reference(targetConversation, targetId);
  }
  unconfirmed(id: string) {
    const row = this.row(id);
    return Boolean(row && row.status !== 'ready' && !this.parsing.has(id));
  }
  private requireSource(conversationId: string, id: string) {
    if (!this.bucket)
      throw new HttpError(
        503,
        '文件存储未配置，请先绑定私有 R2 桶。',
        undefined,
        problem('ATTACHMENT_STORAGE_REQUIRED'),
      );
    const source = this.source(conversationId, id);
    if (source.status !== 'ready')
      throw new HttpError(409, '文件尚未上传完成。', undefined, problem('ATTACHMENT_INVALID'));
    if (!v.safeParse(documentMediaTypeSchema, source.mediaType).success)
      throw new HttpError(415, '请选择文本文件或 PDF。', undefined, problem('ATTACHMENT_INVALID'));
    return source;
  }
  reference(conversationId: string, id: string): DocumentPart {
    const source = this.requireSource(conversationId, id),
      row = this.row(id);
    if (!row || row.status !== 'ready')
      throw new HttpError(
        409,
        '文件尚未解析完成，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const part = v.safeParse(documentPartSchema, {
      type: 'file',
      attachmentId: id,
      name: source.name,
      size: source.size,
      mediaType: source.mediaType,
      ...(source.originalMediaType !== undefined
        ? { originalMediaType: source.originalMediaType }
        : {}),
      sha256: source.sha256,
      version: DOCUMENT_VERSION,
      textSha256: row.sha256,
      characters: row.characters,
      tokens: row.tokens,
      ...(row.csv ? { csv: JSON.parse(row.csv) } : {}),
      ...(this.pdf(id) ? { pdf: this.pdf(id) } : {}),
    });
    if (!part.success)
      throw new HttpError(
        409,
        '文件解析引用无效，请重新上传。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    return part.output;
  }
  async references(
    conversationId: string,
    ids: string[],
    selections: Record<string, DocumentRange[]> = {},
  ) {
    if (new Set(ids).size !== ids.length)
      throw new HttpError(400, '文件引用不能重复。', undefined, problem('ATTACHMENT_INVALID'));
    if (Object.keys(selections).some((id) => !ids.includes(id)))
      throw new HttpError(400, '文件选区缺少对应附件。', undefined, problem('ATTACHMENT_INVALID'));
    const files: DocumentPart[] = [];
    for (const id of ids)
      files.push(
        selections[id]
          ? await this.select(conversationId, id, selections[id])
          : this.reference(conversationId, id),
      );
    return files;
  }
  async parse(conversationId: string, id: string, input?: PDFExtraction) {
    const source = this.requireSource(conversationId, id);
    let prepared: { text: string; pdf: PDFMetadata; pageOffsets?: number[] } | undefined,
      expectedHash: string | null = null;
    if (input !== undefined) {
      if (source.mediaType !== 'application/pdf')
        throw new HttpError(
          415,
          '只有 PDF 使用客户端提取结果。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      const parsed = v.safeParse(pdfExtractionSchema, input);
      if (!parsed.success)
        throw new HttpError(
          400,
          'PDF 提取结果无效，请重新选择文件。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      if (parsed.output.sourceSha256 !== source.sha256)
        throw new HttpError(
          409,
          'PDF 原文件与提取结果不符。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      try {
        validatePdfText(parsed.output);
      } catch (error) {
        throw new HttpError(
          415,
          (error as Error).message,
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      }
      prepared = {
        text: parsed.output.text,
        pdf: parsed.output.pdf,
        ...(parsed.output.pageOffsets ? { pageOffsets: parsed.output.pageOffsets } : {}),
      };
      expectedHash = await digest(new TextEncoder().encode(prepared.text));
      this.requireSource(conversationId, id);
    }
    const row = this.row(id);
    if (
      prepared &&
      row &&
      (row.sha256 !== expectedHash ||
        JSON.stringify(this.pdfData(id)) !==
          JSON.stringify({
            ...prepared.pdf,
            ...(prepared.pageOffsets ? { pageOffsets: prepared.pageOffsets } : {}),
          }))
    )
      throw new HttpError(
        409,
        '此 PDF 已绑定另一份提取结果，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    if (row?.status === 'ready') return this.reference(conversationId, id);
    if (source.mediaType === 'application/pdf' && !prepared)
      throw new HttpError(
        400,
        '请先在浏览器提取并保存 PDF 文本。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    if (row?.status === 'failed')
      throw new HttpError(
        row.errorStatus ?? 415,
        row.error ?? '解析失败，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const active = this.parsing.get(id);
    if (active) return active;
    if (row)
      throw new HttpError(
        409,
        '文件解析尚未确认或正在清理，请稍后重新选择。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const token = crypto.randomUUID(),
      key = `${source.key}/text-v1`;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO attachment_documents VALUES (?, 'parsing', ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)",
        id,
        key,
        Date.now() + ATTACHMENT_LEASE,
        token,
        expectedHash,
      );
      if (prepared)
        this.storage.sql.exec(
          'INSERT INTO attachment_pdf_metadata VALUES (?, ?)',
          id,
          JSON.stringify({
            ...prepared.pdf,
            ...(prepared.pageOffsets ? { pageOffsets: prepared.pageOffsets } : {}),
          }),
        );
    });
    const promise = this.parseSource(conversationId, source, key, token, prepared);
    this.parsing.set(id, promise);
    try {
      return await promise;
    } finally {
      this.parsing.delete(id);
      this.settled(id);
    }
  }
  private async saveIndex(id: string, key: string, index: TextIndex) {
    const payload = JSON.stringify(index),
      sha256 = await digest(new TextEncoder().encode(payload));
    const saved = await this.bucket!.put(key, payload, {
      sha256,
      httpMetadata: { contentType: 'application/json' },
    });
    if (!saved) throw new HttpError(503, '文本索引保存失败。');
    this.storage.sql.exec(
      'INSERT OR REPLACE INTO attachment_text_indexes VALUES (?, ?, ?, ?, ?)',
      id,
      key,
      sha256,
      index.bytes,
      index.lines,
    );
  }
  async toolSource(conversationId: string, file: DocumentPart): Promise<TextToolSource> {
    if (
      JSON.stringify(v.parse(documentPartSchema, documentSource(file))) !==
      JSON.stringify(this.reference(conversationId, file.attachmentId))
    )
      throw new HttpError(409, '文件版本引用无效。');
    const row = this.row(file.attachmentId)!,
      source = this.reference(conversationId, file.attachmentId);
    const saved = this.storage.sql
      .exec<{ key: string; sha256: string; bytes: number; lines: number }>(
        'SELECT * FROM attachment_text_indexes WHERE id=?',
        file.attachmentId,
      )
      .toArray()[0];
    if (!saved) throw new HttpError(409, '文件索引缺失，请先执行离线附件索引维护。');
    // Selection offsets belong to the source UTF-16 text. Map using sparse coordinates,
    // never grant the surrounding gaps to a model tool.
    const ranges = file.selection
      ? await this.selectionByteRanges(file, saved)
      : [{ start: 0, end: row.bytes }];
    return {
      attachmentId: file.attachmentId,
      textSha256: file.textSha256,
      name: file.name,
      mediaType: file.mediaType,
      sourceSha256: row.sha256!,
      validatedOriginal: this.textIntegrity(conversationId, row).validatedOriginal,
      key: row.key,
      indexKey: saved.key,
      indexSha256: saved.sha256,
      bytes: row.bytes,
      characters: source.characters,
      lines: saved.lines,
      ranges,
      ...(this.pdfData(file.attachmentId)?.pageOffsets
        ? { pageOffsets: this.pdfData(file.attachmentId)!.pageOffsets }
        : {}),
    };
  }
  private async selectionByteRanges(file: DocumentPart, saved: { key: string; sha256: string }) {
    const row = this.row(file.attachmentId)!,
      reader = new TextReader(this.bucket!, {
        attachmentId: file.attachmentId,
        textSha256: file.textSha256,
        sourceSha256: row.sha256!,
        name: file.name,
        mediaType: file.mediaType,
        key: row.key,
        indexKey: saved.key,
        indexSha256: saved.sha256,
        bytes: row.bytes,
        characters: file.characters,
        lines: 1,
        ranges: [],
      });
    const ranges = [];
    for (const r of file.selection!.ranges)
      ranges.push({ start: await reader.byteAt(r.start), end: await reader.byteAt(r.end) });
    return ranges;
  }
  private async parseLargeText(conversationId: string, source: Source, token: string) {
    const response = await this.original(conversationId, source.id),
      reader = response.body!.getReader();
    const indexer = new TextIndexer(),
      hash = createHash('sha256');
    let bytes = 0,
      sampledBytes = 0;
    const sampleBytes = new Uint8Array(8192);
    let index: TextIndex;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        indexer.append(part.value);
        hash.update(part.value);
        bytes += part.value.byteLength;
        const count = Math.min(part.value.length, sampleBytes.length - sampledBytes);
        sampleBytes.set(part.value.subarray(0, count), sampledBytes);
        sampledBytes += count;
      }
      index = indexer.finish();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw new HttpError(
        415,
        error instanceof Error ? error.message : '文件必须是 UTF-8 文本。',
        undefined,
        problem('TEXT_INVALID'),
      );
    }
    if (!indexer.hasText)
      throw new HttpError(415, '文件没有可用于问答的文本。', undefined, problem('TEXT_INVALID'));
    const sample = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(
      sampleBytes.subarray(0, sampledBytes),
    );
    if (bytes !== source.size || hash.digest('hex') !== source.sha256)
      throw new HttpError(409, '文本完整性校验失败。');
    this.requireSource(conversationId, source.id);
    if (this.row(source.id)?.token !== token) throw new HttpError(409, '文件解析认领已失效。');
    await this.saveIndex(source.id, `${source.key}/text-index-v1`, index);
    this.storage.sql.exec(
      "UPDATE attachment_documents SET status='ready', lease=0, key=?, sha256=?, characters=?, tokens=?, bytes=? WHERE id=?",
      source.key,
      source.sha256,
      index.characters,
      Math.ceil((estimateTextTokens(sample) * index.characters) / Math.max(1, sample.length)) + 128,
      index.bytes,
      source.id,
    );
    await this.storage.sync();
    return this.reference(conversationId, source.id);
  }
  /** Restore saved canonical text verbatim, preserving its recorded estimator and version. */
  async restoreCanonical(
    conversationId: string,
    id: string,
    expected: DocumentPart,
    expectedBytes: number,
    body: ReadableStream<Uint8Array>,
  ) {
    const source = this.requireSource(conversationId, id),
      existing = this.row(id);
    if (existing) {
      await body.cancel();
      if (
        existing.status === 'ready' &&
        existing.sha256 === expected.textSha256 &&
        existing.bytes === expectedBytes
      )
        return this.reference(conversationId, id);
      throw new HttpError(409, '文件恢复已在进行或需要清理。');
    }
    const key = `${source.key}/text-v1`,
      token = crypto.randomUUID(),
      indexer = new TextIndexer(),
      digest = createHash('sha256');
    this.storage.sql.exec(
      "INSERT INTO attachment_documents VALUES (?, 'parsing', ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)",
      id,
      key,
      Date.now() + ATTACHMENT_LEASE,
      token,
      expected.textSha256,
    );
    const restore = async () => {
      const fixed = new FixedLengthStream(expectedBytes),
        abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('Text restore timed out')), 90_000);
      try {
        await this.storage.sync();
        const copying = body
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(bytes, controller) {
                indexer.append(bytes);
                digest.update(bytes);
                controller.enqueue(bytes);
              },
            }),
          )
          .pipeTo(fixed.writable, { signal: abort.signal });
        const saving = this.bucket!.put(key, fixed.readable, {
          sha256: expected.textSha256,
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        }).catch((error) => {
          abort.abort(error);
          throw error;
        });
        const results = await Promise.allSettled([copying, saving]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        const saved = (results[1] as PromiseFulfilledResult<R2Object | null>).value;
        if (!saved || saved.size !== expectedBytes)
          throw new HttpError(409, '备份文本未完整保存。');
        const index = indexer.finish();
        if (
          index.bytes !== expectedBytes ||
          index.characters !== expected.characters ||
          digest.digest('hex') !== expected.textSha256
        )
          throw new HttpError(409, '备份文本的大小、字符数或校验和不符。');
        this.requireSource(conversationId, id);
        if (this.row(id)?.token !== token) throw new HttpError(409, '文件恢复认领已失效。');
        await this.saveIndex(id, `${source.key}/text-index-v1`, index);
        this.storage.sql.exec(
          "UPDATE attachment_documents SET status='ready',lease=0,sha256=?,characters=?,tokens=?,bytes=?,csv=? WHERE id=?",
          expected.textSha256,
          expected.characters,
          expected.tokens,
          expectedBytes,
          expected.csv ? JSON.stringify(expected.csv) : null,
          id,
        );
        await this.storage.sync();
        return this.reference(conversationId, id);
      } catch (error) {
        this.storage.sql.exec(
          "UPDATE attachment_documents SET status='cleaning',token=NULL,lease=? WHERE id=?",
          Date.now(),
          id,
        );
        try {
          await this.bucket!.delete([key, `${source.key}/text-index-v1`]);
          this.erase(id);
        } catch {
          /* The lease schedules cleanup. */
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    const promise = restore();
    this.parsing.set(id, promise);
    try {
      return await promise;
    } finally {
      this.parsing.delete(id);
      this.settled(id);
    }
  }
  private async parseSource(
    conversationId: string,
    source: Source,
    key: string,
    token: string,
    prepared?: { text: string; pdf: PDFMetadata; pageOffsets?: number[] },
  ) {
    let putStarted = false;
    try {
      await this.storage.sync();
      if (!prepared && source.size > 1024 * 1024) {
        putStarted = true;
        return await this.parseLargeText(conversationId, source, token);
      }
      const response = await this.original(conversationId, source.id, Boolean(prepared));
      const extracted =
        prepared ??
        extractDocument(
          new Uint8Array(await response.arrayBuffer()),
          source.mediaType as Exclude<DocumentPart['mediaType'], 'application/pdf'>,
        );
      const bytes = new TextEncoder().encode(extracted.text),
        sha256 = await digest(bytes);
      this.requireSource(conversationId, source.id);
      this.storage.transactionSync(() => {
        this.storage.sql.exec(
          'UPDATE attachment_documents SET bytes = ? WHERE id = ?',
          bytes.length,
          source.id,
        );
      });
      await this.storage.sync();
      putStarted = true;
      const saved = await this.bucket!.put(key, bytes, {
        sha256,
        storageClass: 'Standard',
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
      if (!saved || saved.size !== bytes.length)
        throw new HttpError(
          503,
          '解析结果未完整保存，请重新选择文件。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      this.requireSource(conversationId, source.id);
      if (this.row(source.id)?.token !== token)
        throw new HttpError(409, '文件解析认领已失效。', undefined, problem('ATTACHMENT_INVALID'));
      await this.saveIndex(source.id, `${source.key}/text-index-v1`, indexText(bytes));
      this.storage.sql.exec(
        "UPDATE attachment_documents SET status = 'ready', lease = 0, sha256 = ?, characters = ?, tokens = ?, bytes = ?, csv = ? WHERE id = ?",
        sha256,
        extracted.text.length,
        estimateDocumentTokens(
          { name: source.name, mediaType: source.mediaType as DocumentPart['mediaType'] },
          extracted.text,
        ),
        bytes.length,
        'csv' in extracted && extracted.csv ? JSON.stringify(extracted.csv) : null,
        source.id,
      );
      await this.storage.sync();
      return this.reference(conversationId, source.id);
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(
              503,
              '解析结果暂时无法保存，请重新选择文件。',
              undefined,
              problem('ATTACHMENT_INVALID'),
            );
      if (this.row(source.id)?.token === token) {
        if (putStarted) {
          this.storage.sql.exec(
            "UPDATE attachment_documents SET status = 'cleaning', token = NULL, lease = ? WHERE id = ?",
            Date.now(),
            source.id,
          );
          try {
            await this.bucket!.delete([key, `${source.key}/text-index-v1`]);
            this.erase(source.id);
          } catch {
            this.storage.sql.exec(
              'UPDATE attachment_documents SET lease = ? WHERE id = ?',
              Date.now() + 30_000,
              source.id,
            );
          }
        } else
          this.storage.sql.exec(
            "UPDATE attachment_documents SET status = 'failed', token = NULL, lease = 0, error = ?, errorStatus = ? WHERE id = ?",
            failure.message,
            failure.status,
            source.id,
          );
      }
      throw failure;
    }
  }
  async read(
    conversationId: string,
    id: string,
  ): Promise<{ file: DocumentPart; text: string; pageOffsets?: number[] }> {
    const file = this.reference(conversationId, id),
      row = this.row(id)!;
    const object = await this.bucket!.get(row.key);
    if (!object)
      throw new HttpError(
        404,
        '文件解析结果不存在，请重新上传。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    if (!textObjectMatches(object, this.textIntegrity(conversationId, row))) {
      await object.body.cancel().catch(() => {});
      throw new HttpError(
        409,
        '解析结果完整性校验失败。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    }
    if (row.bytes > MAX_DOCUMENT_BYTES) {
      await object.body.cancel();
      throw new HttpError(413, '文件超过单次全文读取工作集，请使用按需读取。');
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    this.requireSource(conversationId, id);
    if ((await digest(bytes)) !== file.textSha256)
      throw new HttpError(
        409,
        '解析结果完整性校验失败。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length !== file.characters)
      throw new HttpError(
        409,
        '解析结果长度或预算不符。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    if (file.pdf) await this.original(conversationId, id, true);
    this.requireSource(conversationId, id);
    const pageOffsets = this.pdfData(id)?.pageOffsets;
    return { file, text, ...(pageOffsets ? { pageOffsets } : {}) };
  }
  async previewPage(conversationId: string, id: string, offset: number) {
    this.reference(conversationId, id);
    const row = this.row(id)!;
    const empty = {
      state: 'content_unavailable' as const,
      text: '',
      hasMore: false,
      nextOffset: offset,
    };
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.bytes)
      return { ...empty, state: 'invalid_cursor' as const };
    if (offset === row.bytes) return { ...empty, state: 'available' as const };
    const object = await this.bucket!.get(row.key, {
      range: { offset, length: Math.min(8196, row.bytes - offset) },
    });
    this.requireSource(conversationId, id);
    if (!object) return empty;
    if (!textObjectMatches(object, this.textIntegrity(conversationId, row))) {
      await object.body.cancel();
      return empty;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    this.requireSource(conversationId, id);
    if ((bytes[0] & 0xc0) === 0x80) return { ...empty, state: 'invalid_cursor' as const };
    let end = Math.min(8192, bytes.length);
    if (end < bytes.length) while (end && (bytes[end] & 0xc0) === 0x80) end--;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, end),
      ),
      nextOffset = offset + end;
    return { state: 'available' as const, text, hasMore: nextOffset < row.bytes, nextOffset };
  }
  async select(conversationId: string, id: string, ranges: DocumentRange[]): Promise<DocumentPart> {
    const saved = await this.read(conversationId, id);
    return this.selectFrom(saved, ranges);
  }
  private async selectFrom(
    saved: { file: DocumentPart; text: string },
    ranges: DocumentRange[],
  ): Promise<DocumentPart> {
    if (
      !saved.file.pdf ||
      !v.safeParse(documentRangesSchema, ranges).success ||
      ranges.at(-1)!.end > saved.text.length
    )
      throw new HttpError(400, 'PDF 选区无效。', undefined, problem('ATTACHMENT_INVALID'));
    if (ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === saved.text.length)
      return saved.file;
    const text = selectedDocumentText(saved.text, ranges);
    if (!text.trim())
      throw new HttpError(400, '选区没有可发送的文本。', undefined, problem('ATTACHMENT_INVALID'));
    return v.parse(documentPartSchema, {
      ...saved.file,
      textSha256: await digest(new TextEncoder().encode(text)),
      characters: text.length,
      tokens: estimateDocumentTokens(saved.file, text),
      selection: {
        ranges,
        sourceTextSha256: saved.file.textSha256,
        sourceCharacters: saved.file.characters,
        sourceTokens: saved.file.tokens,
      },
    });
  }
  async response(
    conversationId: string,
    id: string,
    ranges?: DocumentRange[],
    captureInput = false,
  ) {
    const saved = await this.read(conversationId, id);
    const result = ranges
      ? {
          file: await this.selectFrom(saved, ranges),
          text: selectedDocumentText(saved.text, ranges),
        }
      : saved;
    const inputSnapshot = captureInput
      ? await this.inputSnapshots.capture(conversationId, result.file, result.text)
      : undefined;
    return Response.json(
      { ...result, ...(inputSnapshot ? { inputSnapshot } : {}) },
      { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
    );
  }
  async validate(conversationId: string, file: DocumentPart) {
    const saved = { file: this.reference(conversationId, file.attachmentId) };
    if (
      JSON.stringify(v.parse(documentPartSchema, documentSource(file))) !==
        JSON.stringify(saved.file) ||
      (file.selection &&
        JSON.stringify(
          v.parse(
            documentPartSchema,
            (({ material: _, inputMode: __, delivery: ___, ...data }) => data)(file),
          ),
        ) !==
          JSON.stringify(
            await this.select(conversationId, file.attachmentId, file.selection.ranges),
          ))
    )
      throw new HttpError(
        409,
        '文件引用与解析结果不符。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
  }
  isActive(id: string) {
    return this.parsing.has(id) || this.inputSnapshots.isActive(id);
  }
  /** Only explicit copy/import may reconstruct evidence, with an exact hash match. */
  async restoreInputEvidence(
    conversationId: string,
    evidence: (InputEvidenceBackup | undefined)[],
  ) {
    const seen = new Set<string>();
    for (const entry of evidence)
      for (const step of entry?.steps ?? [])
        for (const { item } of step.items) {
          if (item.content !== 'document_snapshot' || !item.documentSnapshot || !item.attachment)
            continue;
          const {
            verification: _,
            delivery: __,
            originalVerification: ___,
            ...metadata
          } = item.attachment;
          const file = v.parse(documentPartSchema, metadata),
            key = `${file.attachmentId}:${item.sha256}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Deleted sources stay unavailable; never use current same-name files.
          if (!this.row(file.attachmentId)) continue;
          await this.validate(conversationId, file);
          const saved = await this.read(conversationId, file.attachmentId),
            text = selectedDocumentText(saved.text, file.selection?.ranges);
          const captured = await this.inputSnapshots.capture(conversationId, file, text);
          if (
            captured.sha256 !== item.sha256 ||
            JSON.stringify(captured) !== JSON.stringify(item.documentSnapshot)
          )
            throw new HttpError(
              409,
              '恢复后的文件输入回执与原始指纹不符。',
              undefined,
              problem('BACKUP_INVALID'),
            );
        }
  }
  lease(id: string) {
    const row = this.row(id);
    return row?.status === 'parsing' ? row.lease : 0;
  }
  erase(id: string) {
    this.storage.sql.exec('DELETE FROM attachment_text_indexes WHERE id = ?', id);
    this.storage.sql.exec('DELETE FROM attachment_documents WHERE id = ?', id);
    this.storage.sql.exec('DELETE FROM attachment_pdf_metadata WHERE id = ?', id);
  }
  nextCleanup() {
    return this.storage.sql
      .exec<{ next: number }>(
        "SELECT MIN(lease) AS next FROM attachment_documents WHERE status IN ('parsing', 'cleaning') HAVING COUNT(*) > 0",
      )
      .toArray()[0]?.next;
  }
  async cleanup() {
    if (!this.bucket) return;
    for (const row of this.storage.sql
      .exec<Row>(
        "SELECT * FROM attachment_documents WHERE status IN ('parsing', 'cleaning') AND lease <= ? ORDER BY lease LIMIT 4",
        Date.now(),
      )
      .toArray()) {
      const current = this.row(row.id);
      if (
        !current ||
        current.key !== row.key ||
        !['parsing', 'cleaning'].includes(current.status) ||
        current.lease > Date.now()
      )
        continue;
      if (this.parsing.has(row.id)) {
        this.storage.sql.exec(
          'UPDATE attachment_documents SET lease = ? WHERE id = ?',
          Date.now() + 30_000,
          row.id,
        );
        continue;
      }
      this.storage.sql.exec(
        "UPDATE attachment_documents SET status = 'cleaning', token = NULL WHERE id = ?",
        row.id,
      );
      try {
        const sourceKey = row.key.endsWith('/text-v1')
          ? row.key.slice(0, -'/text-v1'.length)
          : row.key;
        await this.bucket.delete([`${sourceKey}/text-v1`, `${sourceKey}/text-index-v1`]);
        this.erase(row.id);
      } catch {
        this.storage.sql.exec(
          'UPDATE attachment_documents SET lease = ? WHERE id = ?',
          Date.now() + 30_000,
          row.id,
        );
      }
    }
  }
}
