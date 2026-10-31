import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { indexText } from '../../../shared/attachments/text-index';
import { TEXT_SCAN_BYTES, type TextToolSource } from '../../../shared/attachments/tools';
import {
  validateWebToolCall,
  validateWebToolOutcome,
  type WebToolCall,
} from '../../../shared/tools/tasks';
import {
  ATTACHMENT_TOOL_JOBS_SCHEMA,
  AttachmentToolRunner,
} from '../../../worker/attachments/tool-runner';
import { TextReader } from '../../../worker/attachments/text-reader';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { webToolDefinitions } from '../../../worker/providers/tool-turn';

function fixture(text: string, ranges?: { start: number; end: number }[]) {
  const bytes = Buffer.from(text),
    sha256 = createHash('sha256').update(bytes).digest('hex'),
    index = JSON.stringify(indexText(bytes)),
    indexSha256 = createHash('sha256').update(index).digest('hex');
  const source: TextToolSource = {
    attachmentId: crypto.randomUUID(),
    textSha256: sha256,
    sourceSha256: sha256,
    name: 'untrusted.html',
    mediaType: 'text/plain',
    key: 'private/source',
    indexKey: 'private/index',
    indexSha256,
    bytes: bytes.length,
    characters: text.length,
    lines: text.split('\n').length,
    ranges: ranges ?? [{ start: 0, end: bytes.length }],
  };
  const lengths: number[] = [],
    db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => rows[0],
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };
  query(ATTACHMENT_TOOL_JOBS_SCHEMA);
  const bucket = {
    get: async (key: string, options?: { range: { offset: number; length: number } }) => {
      const data = key === source.key ? bytes : Buffer.from(index);
      if (key === source.key) {
        assert.ok(options?.range, 'source reads must be ranged');
        lengths.push(options!.range.length);
      }
      const body = options?.range
        ? data.subarray(options.range.offset, options.range.offset + options.range.length)
        : data;
      const response = new Response(body);
      return {
        size: data.length,
        checksums: { sha256: createHash('sha256').update(data).digest() },
        body: response.body,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  } as unknown as R2Bucket;
  const runner = () =>
    new AttachmentToolRunner(query, bucket, async (ref) => {
      assert.deepEqual(ref, { attachmentId: source.attachmentId, textSha256: source.textSha256 });
      return source;
    });
  return {
    source,
    db,
    query,
    lengths,
    bucket,
    runner,
    ref: { attachmentId: source.attachmentId, textSha256: source.textSha256 },
  };
}
const call = (name: 'attachment_info' | 'attachment_read' | 'attachment_search', input: unknown) =>
  validateWebToolCall({ id: crypto.randomUUID(), name, input }, [name]);
async function finish(f: ReturnType<typeof fixture>, root: string, input: WebToolCall) {
  if (
    input.name !== 'attachment_info' &&
    input.name !== 'attachment_read' &&
    input.name !== 'attachment_search'
  )
    throw new Error();
  for (let steps = 0; steps < 1000; steps++) {
    // A fresh executor on every batch exercises durable recovery.
    const result = await f.runner().step(root, input, 1_000_000);
    if (!result.pending) {
      validateWebToolOutcome(result.outcome);
      assert.equal(result.outcome.status, 'completed');
      if (result.outcome.status !== 'completed') throw new Error();
      return result.outcome.attachment!;
    }
  }
  throw new Error('Search did not finish');
}

test('all attachment tool definitions are serializable and share runtime input validation', () => {
  const names = ['attachment_info', 'attachment_read', 'attachment_search'] as const;
  assert.equal(webToolDefinitions(names).length, 3);
  for (const definition of webToolDefinitions(names))
    assert.equal(definition.inputSchema.type, 'object');
  assert.throws(() =>
    call('attachment_read', { file: { attachmentId: 'invalid', textSha256: '0'.repeat(64) } }),
  );
});

test('range reads preserve BOM, CRLF, HTML and Unicode across output pages without loading the source', async () => {
  const text = '\ufeff<script>doNotExecute()</script>\r\n中文🙂e\u0301\n'.repeat(1800),
    f = fixture(text),
    root = crypto.randomUUID();
  try {
    let actual = '',
      cursor: string | undefined,
      previousEnd = 0;
    do {
      const result = await finish(
        f,
        root,
        call('attachment_read', { file: f.ref, maxTokens: 2048, ...(cursor ? { cursor } : {}) }),
      );
      assert.ok(result.estimatedTokens <= 2048);
      for (const fragment of result.fragments) {
        assert.equal(fragment.start, previousEnd);
        previousEnd = fragment.end;
        actual += fragment.text;
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(actual, text);
    assert.equal(previousEnd, Buffer.byteLength(text));
    assert.ok(f.lengths.every((n) => n <= TEXT_SCAN_BYTES + 4));
  } finally {
    f.db.close();
  }
});

test('search counts overlapping multi-pattern matches over bounded batches and disjoint selections', async () => {
  const text =
    'a'.repeat(TEXT_SCAN_BYTES - 2) +
    '🙂needle\n' +
    'x'.repeat(TEXT_SCAN_BYTES + 20) +
    'needle🙂aaaa';
  const f = fixture(text),
    root = crypto.randomUUID();
  try {
    const result = await finish(
      f,
      root,
      call('attachment_search', {
        files: [f.ref],
        patterns: [
          { id: 'word', literal: 'needle🙂' },
          { id: 'emoji', literal: '🙂' },
          { id: 'overlap', literal: 'aa' },
        ],
        mode: 'count',
      }),
    );
    assert.equal(result.scanComplete, true);
    assert.equal(result.nextCursor, null);
    assert.equal(result.counts[`${f.ref.attachmentId}:word`], 1);
    assert.equal(result.counts[`${f.ref.attachmentId}:emoji`], 2);
    assert.equal(result.counts[`${f.ref.attachmentId}:overlap`], TEXT_SCAN_BYTES - 3 + 3);
    assert.equal(result.scannedBytes, Buffer.byteLength(text));
    assert.ok(f.lengths.every((n) => n <= TEXT_SCAN_BYTES + 4));
  } finally {
    f.db.close();
  }
  const scoped = fixture('secret needle\nallowed needle\nsecret needle', [{ start: 14, end: 28 }]);
  try {
    const result = await finish(
      scoped,
      root,
      call('attachment_search', {
        files: [scoped.ref],
        patterns: [{ id: 'n', literal: 'needle' }],
        mode: 'snippets',
      }),
    );
    assert.equal(result.matches.length, 1);
    assert.equal(result.fragments[0].text, 'allowed needle');
    assert.ok(!JSON.stringify(result).includes('secret'));
  } finally {
    scoped.db.close();
  }
});

test('search result cursors resume without missing or duplicating matches and are task/version bound', async () => {
  const f = fixture('🙂needle\n'.repeat(80)),
    root = crypto.randomUUID();
  const input = {
    files: [f.ref],
    patterns: [{ id: 'p', literal: 'needle' }],
    mode: 'positions',
    maxTokens: 2048,
  };
  try {
    const positions: number[] = [];
    let cursor: string | undefined;
    do {
      const request = call('attachment_search', { ...input, ...(cursor ? { cursor } : {}) });
      const result = await finish(f, root, request);
      assert.deepEqual(await finish(f, root, request), result, 'same call must replay exactly');
      positions.push(...result.matches.map((m) => m.start));
      cursor = result.nextCursor ?? undefined;
      if (cursor) {
        const wrongRoot = call('attachment_search', { ...input, cursor });
        await assert.rejects(() => finish(f, crypto.randomUUID(), wrongRoot), /expired|authorized/);
      }
    } while (cursor);
    assert.equal(positions.length, 80);
    assert.equal(new Set(positions).size, 80);
  } finally {
    f.db.close();
  }
});

test('line/page positions and sparse UTF-16 mappings handle long lines and reject split Unicode positions', async () => {
  const text = '🙂' + 'x'.repeat(TEXT_SCAN_BYTES * 2) + '\n末行\r\n',
    f = fixture(text),
    root = crypto.randomUUID();
  try {
    const result = await finish(f, root, call('attachment_read', { file: f.ref, line: 2 }));
    assert.equal(result.fragments[0].text, '末行\r\n');
    const reader = new TextReader(f.bucket, f.source);
    assert.equal(await reader.byteAt(2), 4);
    await assert.rejects(() => reader.byteAt(1), /Unicode/);
    assert.equal(await reader.byteAt(text.length), Buffer.byteLength(text));
  } finally {
    f.db.close();
  }
});
