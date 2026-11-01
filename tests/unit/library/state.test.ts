import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeLibraryState, LibraryState } from '../../../worker/library/state';
import { LibraryActivityIndex } from '../../../worker/library/activity';
import type { SqlQuery } from '../../../worker/generation/metrics';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,createdAt INTEGER,updatedAt INTEGER);
    CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY,pinned INTEGER);
    CREATE TABLE conversation_titles(id TEXT PRIMARY KEY,source TEXT,task TEXT);
    CREATE TABLE conversation_activity(id TEXT PRIMARY KEY,version INTEGER,payload TEXT);
    CREATE TABLE conversation_deletions(id TEXT PRIMARY KEY,deletedAt INTEGER,completed INTEGER);
    CREATE TABLE conversation_copies(id TEXT PRIMARY KEY,status TEXT,lease INTEGER);
    CREATE TABLE archive_imports(id TEXT PRIMARY KEY,status TEXT,lease INTEGER);
  `);
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...values: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(values as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  initializeLibraryState(query);
  return { db, query, state: new LibraryState(query) };
}

test('all index stores advance a single transactional watermark; no-op updates and rolled back writes do not', () => {
  const f = fixture();
  try {
    const initial = f.state.current();
    const writes = [
      "INSERT INTO conversations VALUES('a','First',1,1)",
      "INSERT INTO conversation_metadata VALUES('a',0)",
      "INSERT INTO conversation_titles VALUES('a','fallback',NULL)",
      "INSERT INTO conversation_activity VALUES('a',1,'{}')",
      "INSERT INTO conversation_copies VALUES('copy','copying',100)",
      "INSERT INTO archive_imports VALUES('import','uploading',100)",
      "UPDATE conversations SET title='Second' WHERE id='a'",
      "UPDATE conversations SET updatedAt=2 WHERE id='a'",
      "UPDATE conversation_metadata SET pinned=1 WHERE id='a'",
      "UPDATE conversation_titles SET task='queued' WHERE id='a'",
      "UPDATE conversation_titles SET source='ai',task='completed' WHERE id='a'",
      "UPDATE conversation_activity SET version=2,payload='new' WHERE id='a'",
      "UPDATE conversation_copies SET status='completed' WHERE id='copy'",
      "UPDATE archive_imports SET status='completed' WHERE id='import'",
      "INSERT INTO conversation_deletions VALUES('a',123,0)",
      "DELETE FROM conversations WHERE id='a'",
    ];
    for (const [index, sql] of writes.entries()) {
      f.db.exec(sql);
      assert.deepEqual(f.state.current(), { ...initial, revision: index + 1 });
    }
    const before = f.state.current();
    for (const sql of [
      "UPDATE conversation_metadata SET pinned=1 WHERE id='a'",
      "UPDATE archive_imports SET lease=200 WHERE id='import'",
      "UPDATE conversation_copies SET lease=200 WHERE id='copy'",
      "UPDATE conversation_deletions SET completed=1 WHERE id='a'",
      "DELETE FROM conversations WHERE id='missing'",
    ])
      f.db.exec(sql);
    assert.deepEqual(f.state.current(), before);
    f.db.exec("BEGIN; INSERT INTO conversations VALUES('rolled-back','Temporary',1,1)");
    assert.equal(f.state.current().revision, before.revision + 1);
    f.db.exec('ROLLBACK');
    assert.deepEqual(f.state.current(), before);
    initializeLibraryState(f.query);
    assert.deepEqual(f.state.current(), before);
  } finally {
    f.db.close();
  }
});

test('late and duplicate activity reports cannot advance the Library revision or revive a deleted conversation', () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO conversations VALUES('a','Activity',1,1)");
    const activity = new LibraryActivityIndex(f.query);
    activity.accept('a', { status: 'idle', version: 2, updatedAt: 2 });
    const watermark = f.state.current();
    activity.accept('a', { status: 'idle', version: 1, updatedAt: 1 });
    activity.accept('a', { status: 'idle', version: 2, updatedAt: 2 });
    assert.deepEqual(f.state.current(), watermark);
    f.db.exec("INSERT INTO conversation_deletions VALUES('a',123,0)");
    const deleted = f.state.current();
    activity.accept('a', { status: 'idle', version: 3, updatedAt: 3 });
    assert.deepEqual(f.state.current(), deleted);
  } finally {
    f.db.close();
  }
});
