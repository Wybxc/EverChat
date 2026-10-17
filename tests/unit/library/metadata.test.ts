import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeConversationMetadata } from '../../../worker/library/metadata';

function sqliteStorage(db: DatabaseSync, beforeExec: (statement: string) => void = () => {}) {
  return {
    sql: {
      exec(statement: string) {
        beforeExec(statement);
        const rows = db.prepare(statement).all();
        return { toArray: () => rows };
      },
    },
    transactionSync(operation: () => void) {
      db.exec('BEGIN');
      try {
        operation();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
}

test('retiring archive state is repeatable, preserving IDs, pins and conversation timestamps', () => {
  const db = new DatabaseSync(':memory:');
  const storage = sqliteStorage(db);
  try {
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, updatedAt INTEGER);
      INSERT INTO conversations VALUES ('a', 10), ('b', 20), ('c', 30);
      CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL);
      INSERT INTO conversation_metadata VALUES ('a', 1, 1), ('b', 0, 1), ('c', 1, 0);`);
    const before = db.prepare('SELECT * FROM conversations').all();
    initializeConversationMetadata(storage);
    initializeConversationMetadata(storage);
    assert.deepEqual(db.prepare('SELECT * FROM conversations').all(), before);
    assert.deepEqual(
      db
        .prepare('SELECT * FROM conversation_metadata ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 'a', pinned: 1 },
        { id: 'b', pinned: 0 },
        { id: 'c', pinned: 1 },
      ],
    );
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(conversation_metadata)')
        .all()
        .map((row) => row.name),
      ['id', 'pinned'],
    );
  } finally {
    db.close();
  }
});

test('an interrupted metadata rewrite rolls back the old table and can retry safely', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL);
      INSERT INTO conversation_metadata VALUES ('preserved', 1, 1);`);
    const storage = sqliteStorage(db, (statement) => {
      if (statement.startsWith('ALTER TABLE')) throw new Error('Simulated storage failure');
    });
    assert.throws(() => initializeConversationMetadata(storage), /Simulated storage failure/);
    assert.deepEqual(
      { ...db.prepare('SELECT * FROM conversation_metadata').get() },
      { id: 'preserved', pinned: 1, archived: 1 },
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='conversation_metadata_clean'",
        )
        .get()!.count,
      0,
    );
    initializeConversationMetadata(sqliteStorage(db));
    assert.deepEqual(
      { ...db.prepare('SELECT * FROM conversation_metadata').get() },
      { id: 'preserved', pinned: 1 },
    );
  } finally {
    db.close();
  }
});
