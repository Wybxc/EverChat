import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TextIndexer } from '../../shared/attachments/text-index';
import { encodeValue, type Statement } from './storage-protocol';

export interface TextIndexObject {
  id: string;
  key: string;
  sha256: string;
  file: string;
}
/** Runs only in Node during a stopped-service maintenance window. */
export async function rebuildTextIndexes(db: DatabaseSync, directory: string) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  if (!tables.includes('attachment_documents') || !tables.includes('attachments'))
    return { statements: [] as Statement[], objects: [] as TextIndexObject[] };
  const rows = db
    .prepare(
      `SELECT d.*, a.key AS sourceKey FROM attachment_documents d JOIN attachments a ON a.id=d.id
    WHERE d.status='ready' AND a.removed=0 AND a.status='ready' ORDER BY d.id`,
    )
    .all();
  const statements: Statement[] = [],
    objects: TextIndexObject[] = [];
  for (const row of rows) {
    const indexer = new TextIndexer(),
      sha = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, `${row.id}.text.bin`))) {
      indexer.append(chunk as Buffer);
      sha.update(chunk as Buffer);
    }
    const index = indexer.finish();
    assert.equal(sha.digest('hex'), row.sha256, 'Saved text checksum differs from the database');
    assert.equal(index.bytes, row.bytes, 'Saved text byte count differs from the database');
    assert.equal(
      index.characters,
      row.characters,
      'Saved text character count differs from the database',
    );
    const payload = JSON.stringify(index),
      sha256 = createHash('sha256').update(payload).digest('hex'),
      key = `${row.sourceKey}/text-index-v1`,
      file = `${row.id}.index.json`;
    await writeFile(join(directory, file), payload, { mode: 0o600 });
    const sql = 'INSERT OR REPLACE INTO attachment_text_indexes VALUES(?,?,?,?,?)',
      args = [String(row.id), key, sha256, index.bytes, index.lines];
    db.prepare(sql).run(...args);
    statements.push({ sql, args: args.map(encodeValue) });
    objects.push({ id: String(row.id), key, sha256, file });
  }
  return { statements, objects };
}
