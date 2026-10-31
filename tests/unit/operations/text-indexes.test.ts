import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { rebuildTextIndexes } from '../../../scripts/operations/rebuild-text-indexes';
import { migrateStorage } from '../../../scripts/operations/migrations';
import { indexText } from '../../../shared/attachments/text-index';

test('offline conversion builds immutable indexes from canonical backup bytes and rejects corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'everchat-text-indexes-')),
    db = new DatabaseSync(':memory:');
  const id = crypto.randomUUID(),
    text = '\ufeff<html>中🙂\r\n'.repeat(6000),
    bytes = Buffer.from(text),
    sha = createHash('sha256').update(bytes).digest('hex');
  try {
    db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,5)',
    );
    db.exec('CREATE TABLE attachments(id TEXT PRIMARY KEY,key TEXT,status TEXT,removed INTEGER)');
    db.exec(
      'CREATE TABLE attachment_documents(id TEXT PRIMARY KEY,key TEXT,status TEXT,sha256 TEXT,bytes INTEGER,characters INTEGER)',
    );
    db.prepare('INSERT INTO attachments VALUES (?,?,?,0)').run(id, 'source/key', 'ready');
    db.prepare('INSERT INTO attachment_documents VALUES (?,?,?,?,?,?)').run(
      id,
      'canonical/text',
      'ready',
      sha,
      bytes.length,
      text.length,
    );
    await writeFile(join(directory, `${id}.text.bin`), bytes);
    const patch = await migrateStorage(db, 'library');
    assert.ok(patch.some((s) => s.sql.includes('attachment_text_indexes')));
    const result = await rebuildTextIndexes(db, directory);
    assert.equal(result.objects.length, 1);
    assert.equal(result.statements.length, 1);
    assert.equal(result.objects[0].key, 'source/key/text-index-v1');
    const payload = await readFile(join(directory, result.objects[0].file));
    assert.equal(createHash('sha256').update(payload).digest('hex'), result.objects[0].sha256);
    assert.deepEqual(JSON.parse(payload.toString()), indexText(bytes));
    assert.equal(db.prepare('SELECT version FROM storage_schema').get()!.version, 6);
    await writeFile(join(directory, `${id}.text.bin`), 'corrupted');
    await assert.rejects(rebuildTextIndexes(db, directory), /checksum/);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
