import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateStorage } from '../../../scripts/operations/migrations';
import { decodeValue, MIGRATION_TABLES } from '../../../scripts/operations/storage-protocol';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import { initializeConversation } from '../../../worker/conversation/schema';
import {
  initializeStorageSchema,
  STORAGE_SCHEMA_VERSION,
} from '../../../worker/platform/storage-schema';
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

test('retired summary settings and private wire storage are cleaned only by a replayable offline patch', async () => {
  const local = new DatabaseSync(':memory:'),
    remote = new DatabaseSync(':memory:');
  try {
    for (const table of ['conversation_settings', 'tool_stream_commits'])
      assert.ok(MIGRATION_TABLES.conversation.includes(table));
    for (const db of [local, remote]) {
      initializeConversation(storage(db).sql, false);
      db.exec("UPDATE conversation_state SET epoch='sdk-fixture'");
      db.exec('CREATE TABLE tool_stream_commits(runId TEXT,payload TEXT)');
      db.exec("INSERT INTO tool_stream_commits VALUES ('old','private-wire')");
      db.prepare('INSERT INTO conversation_settings VALUES (1,?)').run(
        JSON.stringify({
          ...DEFAULT_CONVERSATION_SETTINGS,
          useSummaries: false,
          contextBudget: 8192,
        }),
      );
    }
    const before = snapshot(remote);
    initializeConversation(storage(remote).sql, false);
    assert.deepEqual(snapshot(remote), before);
    const patch = await migrateStorage(local, 'conversation');
    for (const statement of patch)
      remote.prepare(statement.sql).run(...statement.args.map(decodeValue));
    assert.deepEqual(snapshot(remote), snapshot(local));
    assert.equal(
      remote.prepare("SELECT name FROM sqlite_master WHERE name='tool_stream_commits'").get(),
      undefined,
    );
    const settings = JSON.parse(
      String(remote.prepare('SELECT payload FROM conversation_settings').get()!.payload),
    );
    assert.equal('useSummaries' in settings, false);
    assert.equal(settings.contextBudget, 8192);
  } finally {
    local.close();
    remote.close();
  }
});

test('offline conversion refuses active raw supplier streams without modifying the source', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeConversation(storage(db).sql, false);
    db.exec(
      "INSERT INTO messages(id,role,content,status,createdAt) VALUES ('a','assistant','prefix','running',1)",
    );
    db.exec(
      "INSERT INTO runs(id,conversationId,assistantId,context,updatedAt,streamVersion) VALUES ('r','c','a','[]',1,'raw-sse-v1')",
    );
    const before = snapshot(db);
    await assert.rejects(migrateStorage(db, 'conversation'), /旧版流任务仍在进行/);
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test('schema 1 accounting upgrades are offline, including deleted conversations', async () => {
  for (const deleted of [false, true]) {
    const local = new DatabaseSync(':memory:'),
      remote = new DatabaseSync(':memory:');
    try {
      for (const db of [local, remote]) {
        initializeConversation(storage(db).sql, false);
        db.exec("UPDATE conversation_state SET epoch='fixed-schema-1-fixture'");
        db.exec('DROP TABLE usage_outbox; UPDATE storage_schema SET version=1');
        if (deleted) db.exec('INSERT INTO conversation_deletion VALUES (1,123)');
      }
      const original = snapshot(remote);
      assert.throws(() => initializeConversation(storage(remote).sql, false), /本地运维迁移/);
      assert.deepEqual(snapshot(remote), original);
      const patch = await migrateStorage(local, 'conversation');
      for (const statement of patch)
        remote.prepare(statement.sql).run(...statement.args.map(decodeValue));
      assert.deepEqual(snapshot(remote), snapshot(local));
      assert.equal(
        remote.prepare('SELECT version FROM storage_schema').get()!.version,
        STORAGE_SCHEMA_VERSION,
      );
      assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM usage_outbox').get()!.n, 0);
      initializeConversation(storage(remote).sql, false);
      if (deleted)
        assert.equal(
          remote.prepare('SELECT deletedAt FROM conversation_deletion').get()!.deletedAt,
          123,
        );
    } finally {
      local.close();
      remote.close();
    }
  }
});

test('application startup initializes a fresh schema repeatedly and rejects old or future databases without modifying them', async () => {
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
    await assert.rejects(migrateStorage(db, 'conversation'), /Unsupported/);
    assert.deepEqual(snapshot(db), future);
  } finally {
    db.close();
  }
});

test('local conversion emits a replayable patch, preserving IDs, timestamps, pins, copies and service credentials', async () => {
  const local = legacyLibrary(),
    remote = legacyLibrary();
  try {
    const patch = await migrateStorage(local, 'library');
    // Simulate a missing acknowledgement: each acknowledged batch is applied only
    // once by the maintenance bridge. Normal startup never executes this patch.
    remote.exec('BEGIN');
    for (const statement of patch) {
      if (statement.args.length)
        remote.prepare(statement.sql).run(...statement.args.map(decodeValue));
      else remote.exec(statement.sql);
    }
    remote.exec('COMMIT');
    assert.deepEqual(snapshot(remote), snapshot(local));
    for (const name of [
      'mcp_uploads',
      'mcp_upload_files',
      'mcp_attachment_parts',
      'mcp_upload_files_owner',
      'mcp_attachment_parts_cleanup',
    ]) {
      assert.ok(local.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), name);
      assert.deepEqual(
        remote.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name),
        local.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name),
      );
    }
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
    await migrateStorage(remote, 'library');
    assert.deepEqual(snapshot(remote), before);
  } finally {
    local.close();
    remote.close();
  }
});

test('failed offline conversions roll back all changes and leave the source intact for retry', async () => {
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
    await assert.rejects(migrateStorage(db, 'conversation'));
    assert.deepEqual(snapshot(db), before);
    db.exec('DELETE FROM stream_commits');
    await migrateStorage(db, 'conversation');
    initializeConversation(storage(db).sql, false);
  } finally {
    db.close();
  }
});
