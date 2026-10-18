import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateStorage } from '../../../scripts/operations/migrate-storage';
import { decodeValue } from '../../../scripts/operations/storage-protocol';
import { initializeConversation } from '../../../worker/conversation/schema';
import { initializeStorageSchema } from '../../../worker/platform/storage-schema';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { initializeConversationMetadata } from '../../../worker/library/metadata';

function storage(db: DatabaseSync) {
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as (string | number | null)[])) as T[];
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
  return { sql: { exec: query }, query } as unknown as DurableObjectStorage & { query: SqlQuery };
}
function legacyLibrary() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, updatedAt INTEGER);
    INSERT INTO conversations VALUES ('a',10),('b',20);
    CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY,pinned INTEGER NOT NULL,archived INTEGER NOT NULL);
    INSERT INTO conversation_metadata VALUES ('a',1,1),('b',0,0);
    CREATE TABLE web_tool_service(id INTEGER PRIMARY KEY,apiKey TEXT NOT NULL,dailyLimit INTEGER NOT NULL);
    INSERT INTO web_tool_service VALUES (1,'private-tavily-key',20);
    CREATE TABLE conversation_copies(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL,messageId TEXT,status TEXT NOT NULL,createdAt INTEGER NOT NULL,lease INTEGER NOT NULL,error TEXT,errorStatus INTEGER);
    INSERT INTO conversation_copies VALUES ('copy','a',NULL,'completed',10,0,NULL,NULL);`);
  return db;
}
const snapshot = (db: DatabaseSync) =>
  db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(({ name, sql }) => ({ name, sql, rows: db.prepare(`SELECT * FROM "${name}"`).all() }));

test('application startup initializes a fresh schema repeatedly and rejects old or future databases without modifying them', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Vite/Miniflare records an object's name before invoking its constructor.
    // Runtime metadata alone must not classify a fresh application DB as legacy.
    db.exec(
      "CREATE TABLE __miniflare_do_name(name TEXT); INSERT INTO __miniflare_do_name VALUES ('fresh')",
    );
    initializeConversation(storage(db).sql, false);
    const before = snapshot(db);
    initializeConversation(storage(db).sql, false);
    assert.deepEqual(snapshot(db), before);
    db.exec('DROP TABLE storage_schema');
    const legacy = snapshot(db);
    assert.throws(() => initializeConversation(storage(db).sql, false), /本地运维迁移/);
    assert.deepEqual(snapshot(db), legacy);
    const oldLibrary = legacyLibrary();
    try {
      const old = snapshot(oldLibrary);
      assert.throws(() => initializeStorageSchema(storage(oldLibrary).query), /本地运维迁移/);
      assert.deepEqual(snapshot(oldLibrary), old);
    } finally {
      oldLibrary.close();
    }
    db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES (1,999)',
    );
    const future = snapshot(db);
    assert.throws(() => initializeConversation(storage(db).sql, false), /本地运维迁移/);
    assert.throws(() => migrateStorage(db, 'conversation'), /Unsupported/);
    assert.deepEqual(snapshot(db), future);
  } finally {
    db.close();
  }
});

test('local conversion emits a replayable patch, preserving IDs, timestamps, pins, copies and service credentials', () => {
  const local = legacyLibrary(),
    remote = legacyLibrary();
  try {
    const patch = migrateStorage(local, 'library');
    // Simulate a missing acknowledgement: each acknowledged batch is applied only
    // once by the maintenance bridge. Normal startup never executes this patch.
    remote.exec('BEGIN');
    for (const statement of patch)
      remote.prepare(statement.sql).run(...statement.args.map(decodeValue));
    remote.exec('COMMIT');
    assert.deepEqual(snapshot(remote), snapshot(local));
    assert.equal(
      local.prepare('SELECT apiKey FROM web_tool_credentials').get()!.apiKey,
      'private-tavily-key',
    );
    assert.equal(local.prepare('SELECT apiKey FROM web_tool_service').get()!.apiKey, '');
    assert.deepEqual(
      local
        .prepare('PRAGMA table_info(conversation_metadata)')
        .all()
        .map(({ name }) => name),
      ['id', 'pinned'],
    );
    assert.equal(
      local.prepare('SELECT updatedAt FROM conversations WHERE id=?').get('a')!.updatedAt,
      10,
    );
    assert.equal(
      local.prepare('SELECT pinned FROM conversation_metadata WHERE id=?').get('a')!.pinned,
      1,
    );
    assert.equal(local.prepare('SELECT sourceId FROM conversation_copies').get()!.sourceId, 'a');
    initializeStorageSchema(storage(remote).query);
    initializeConversationMetadata(storage(remote));
    const before = snapshot(remote);
    migrateStorage(remote, 'library');
    assert.deepEqual(snapshot(remote), before);
  } finally {
    local.close();
    remote.close();
  }
});

test('failed offline conversions roll back all changes and leave the source intact for retry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeConversation(storage(db).sql, false);
    db.exec(`DROP TABLE storage_schema;
      CREATE TABLE events(seq INTEGER PRIMARY KEY,payload TEXT); INSERT INTO events VALUES (10,'old');
      INSERT INTO messages(id,role,content,status,createdAt,runId) VALUES ('a','assistant','','running',1,'r');
      INSERT INTO runs(id,conversationId,assistantId,context,updatedAt) VALUES ('r','c','a','[]',1);
      CREATE TABLE stream_commits(runId TEXT,chunkSeq INTEGER,payload TEXT);
      INSERT INTO stream_commits VALUES ('r',1,'malformed');`);
    const before = snapshot(db);
    assert.throws(() => migrateStorage(db, 'conversation'));
    assert.deepEqual(snapshot(db), before);
    db.exec('DELETE FROM stream_commits');
    migrateStorage(db, 'conversation');
    initializeConversation(storage(db).sql, false);
  } finally {
    db.close();
  }
});
