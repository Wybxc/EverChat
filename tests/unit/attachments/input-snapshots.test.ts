import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DocumentInputSnapshots } from '../../../worker/attachments/input-snapshots';
import { documentPrompt, type DocumentPart } from '../../../shared/attachments/documents';

function fixture() {
  const db = new DatabaseSync(':memory:'),
    objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let removed = false,
    puts = 0;
  const lengths: number[] = [];
  const storage = {
    sql: {
      exec(sql: string, ...args: (string | number | null)[]) {
        const rows = db.prepare(sql).all(...args);
        return { toArray: () => rows };
      },
    },
    sync: async () => {},
  } as unknown as DurableObjectStorage;
  const metadata = (value: { bytes: Uint8Array; etag: string }) => ({
    size: value.bytes.length,
    etag: value.etag,
    checksums: { sha256: createHash('sha256').update(value.bytes).digest() },
  });
  const bucket = {
    async head(key: string) {
      const value = objects.get(key);
      return value ? metadata(value) : null;
    },
    async put(key: string, bytes: Uint8Array) {
      puts++;
      const value = { bytes, etag: crypto.randomUUID() };
      objects.set(key, value);
      return metadata(value);
    },
    async get(
      key: string,
      options: { onlyIf: { etagMatches: string }; range: { offset: number; length: number } },
    ) {
      const value = objects.get(key);
      if (!value || value.etag !== options.onlyIf.etagMatches) return null;
      lengths.push(options.range.length);
      return {
        body: {},
        arrayBuffer: async () =>
          value.bytes.slice(options.range.offset, options.range.offset + options.range.length)
            .buffer,
      };
    },
    async delete(keys: string[]) {
      for (const key of keys) objects.delete(key);
    },
  } as unknown as R2Bucket;
  const store = () =>
    new DocumentInputSnapshots(storage, bucket, (conversation, id) => {
      if (removed || conversation !== 'authorized' || id !== 'file') throw new Error('not found');
      return { key: 'private/file' };
    });
  return {
    db,
    objects,
    lengths,
    store,
    puts: () => puts,
    remove: () => {
      removed = true;
    },
  };
}
const file = { attachmentId: 'file', name: '1021.typ', mediaType: 'text/plain' } as DocumentPart;

test('document receipts deduplicate versions and read exact Unicode input through bounded R2 ranges after restart', async () => {
  const f = fixture();
  try {
    const text = '定义🙂e\u0301与反例\n'.repeat(3000),
      expected = documentPrompt(file, text);
    const snapshot = await f.store().capture('authorized', file, text);
    assert.equal(snapshot.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(await f.store().capture('authorized', file, text), snapshot);
    assert.equal(f.puts(), 1);
    const afterRestart = f.store();
    let output = '',
      offset = 0;
    for (;;) {
      const page = await afterRestart.page('authorized', 'file', snapshot, offset);
      assert.equal(page.state, 'available');
      assert.ok(!page.text.includes('\ufffd'));
      output += page.text;
      offset = page.nextOffset;
      if (!page.hasMore) break;
    }
    assert.equal(output, expected);
    assert.equal(offset, snapshot.bytes);
    assert.ok(f.lengths.every((n) => n <= 8196));
    const emoji = Buffer.from(expected).indexOf(Buffer.from('🙂'));
    assert.equal(
      (await afterRestart.page('authorized', 'file', snapshot, emoji + 1)).state,
      'invalid_cursor',
    );
    assert.equal(
      (await afterRestart.page('other', 'file', snapshot, 0)).state,
      'content_unavailable',
    );
    await f.store().capture('authorized', file, text + 'new version');
    assert.equal(f.puts(), 2);
    f.remove();
    assert.equal(
      (await afterRestart.page('authorized', 'file', snapshot, 0)).state,
      'content_unavailable',
    );
    assert.equal(await afterRestart.cleanup('file'), true);
    assert.equal(f.objects.size, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM document_input_snapshots').get()!.n, 0);
  } finally {
    f.db.close();
  }
});

test('replacement of a private snapshot object cannot silently change a historical input receipt', async () => {
  const f = fixture();
  try {
    const saved = await f.store().capture('authorized', file, 'original');
    const object = [...f.objects.values()][0];
    object.bytes = new TextEncoder().encode('changed');
    object.etag = 'replacement';
    assert.equal(
      (await f.store().page('authorized', 'file', saved, 0)).state,
      'content_unavailable',
    );
  } finally {
    f.db.close();
  }
});
