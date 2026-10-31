import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DocumentStore } from '../../../worker/attachments/documents';
import type { Attachment } from '../../../shared/attachments/files';
import { TextReader, textObjectMatches } from '../../../worker/attachments/text-reader';

test('only a fully verified immutable original can omit R2 checksum metadata', () => {
  const source = { bytes: 10, sourceSha256: 'a'.repeat(64), validatedOriginal: true };
  const object = { size: 10, checksums: {} } as R2Object;
  assert.equal(textObjectMatches(object, source), true);
  assert.equal(textObjectMatches(object, { ...source, validatedOriginal: false }), false);
  assert.equal(textObjectMatches({ ...object, size: 9 }, source), false);
  assert.equal(
    textObjectMatches({ ...object, checksums: { sha256: new Uint8Array(32).buffer } }, source),
    false,
  );
});

function fixture(bytes: Buffer) {
  const db = new DatabaseSync(':memory:'),
    objects = new Map<string, Buffer>(),
    gets: number[] = [];
  const id = crypto.randomUUID(),
    conversationId = crypto.randomUUID(),
    key = 'attachments/source';
  const source: Attachment & { key: string } = {
    id,
    conversationId,
    key,
    name: 'untrusted.html',
    mediaType: 'text/plain',
    originalMediaType: 'text/html',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'ready',
    createdAt: 1,
    error: null,
  };
  objects.set(key, bytes);
  let failIndex = false;
  const sql = {
    exec(statement: string, ...args: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...args);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
  const storage = {
    sql,
    sync: async () => {},
    transactionSync<T>(fn: () => T) {
      db.exec('BEGIN');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const bucket = {
    async put(k: string, data: string | Uint8Array | ReadableStream) {
      const value = Buffer.from(
        await new Response(
          data instanceof Uint8Array ? new Uint8Array(data).buffer : data,
        ).arrayBuffer(),
      );
      objects.set(k, value);
      if (failIndex && k.endsWith('/text-index-v1'))
        throw new Error('Injected lost index write response');
      return { size: value.length };
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) objects.delete(k);
    },
    async get(k: string, options?: { range: { offset: number; length: number } }) {
      const value = objects.get(k);
      if (!value) return null;
      if (k === key) gets.push(options?.range.length ?? value.length);
      const selected = options
        ? value.subarray(options.range.offset, options.range.offset + options.range.length)
        : value;
      const response = new Response(new Uint8Array(selected).buffer);
      return {
        size: value.length,
        checksums: k === key ? {} : { sha256: createHash('sha256').update(value).digest() },
        body: response.body,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  } as unknown as R2Bucket;
  const store = new DocumentStore(
    storage,
    bucket,
    (c, i) => {
      assert.equal(c, conversationId);
      assert.equal(i, id);
      return source;
    },
    async () => {
      let offset = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const next = Math.min(bytes.length, offset + 32771);
            controller.enqueue(bytes.subarray(offset, next));
            offset = next;
          },
        }),
      );
      response.arrayBuffer = async () => {
        throw new Error('The large source must not be buffered');
      };
      return response;
    },
    () => {},
  );
  return {
    db,
    id,
    conversationId,
    key,
    source,
    objects,
    gets,
    store,
    bucket,
    failIndex: () => {
      failIndex = true;
    },
  };
}

test('large HTML is indexed incrementally even when its prefix is whitespace; previews and tools only read ranges', async () => {
  const text = ' '.repeat(9000) + '\ufeff<html>中🙂\r\n'.repeat(80000),
    f = fixture(Buffer.from(text));
  try {
    const file = await f.store.parse(f.conversationId, f.id);
    assert.equal(file.characters, text.length);
    assert.equal(file.textSha256, f.source.sha256);
    assert.equal(file.originalMediaType, 'text/html');
    assert.equal(f.objects.size, 2, 'canonical large text reuses the immutable original');
    const manifest = await f.store.toolSource(f.conversationId, { ...file, delivery: 'on_demand' });
    const reader = new TextReader(f.bucket, manifest);
    assert.equal((await reader.index()).characters, text.length);
    assert.equal((await reader.fragment(9000, 9020)).text, text.slice(9000, 9012));
    let offset = 0,
      preview = '';
    for (let i = 0; i < 3; i++) {
      const page = await f.store.previewPage(f.conversationId, f.id, offset);
      assert.equal(page.state, 'available');
      assert.ok(page.nextOffset > offset);
      preview += page.text;
      offset = page.nextOffset;
    }
    assert.equal(preview, text.slice(0, preview.length));
    assert.ok(f.gets.every((n) => n <= 8196));
    f.db.prepare('DELETE FROM attachment_text_indexes').run();
    await assert.rejects(f.store.toolSource(f.conversationId, file), /离线/);
  } finally {
    f.db.close();
  }
});

test('invalid UTF-8 at EOF and lost index writes clean derived data without deleting the original', async () => {
  for (const invalid of [true, false]) {
    const f = fixture(
      Buffer.concat([
        Buffer.from('x'.repeat(1024 * 1024 + 5)),
        Buffer.from(invalid ? [0xc3] : [0x78]),
      ]),
    );
    try {
      if (!invalid) f.failIndex();
      await assert.rejects(
        f.store.parse(f.conversationId, f.id),
        invalid ? /UTF|encoded|encoding|序列|文本/i : /保存/,
      );
      assert.deepEqual([...f.objects.keys()], [f.key]);
      assert.equal(f.db.prepare('SELECT * FROM attachment_text_indexes').all().length, 0);
      assert.equal(f.db.prepare('SELECT * FROM attachment_documents').all().length, 0);
    } finally {
      f.db.close();
    }
  }
});
