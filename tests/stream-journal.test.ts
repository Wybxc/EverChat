import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeConversation } from '../worker/conversation-schema';
import { StreamJournal } from '../worker/stream-journal';
import { batchPayload, MAX_BATCH_BYTES, payloadBytes, STREAM_VERSION, streamBatches, validateBatch } from '../shared/stream-batches';
import { applyChange, type Message } from '../shared/types';
import type { SqlQuery } from '../worker/generation-metrics';

const message: Message = { id: 'assistant', role: 'assistant', content: '', reasoning: '', status: 'running', createdAt: 1,
  runId: 'run', parentId: 'user', revisionOf: null, error: null, streamVersion: STREAM_VERSION, durableOffset: 0 };

function database() {
  const db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(statement: string, ...bindings: SqlStorageValue[]) => {
    const prepared = db.prepare(statement);
    const rows = prepared.all(...bindings as (string | number | null)[]) as T[];
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, *[Symbol.iterator]() { yield* rows; } };
  };
  const sql = { exec: query } as unknown as SqlStorage;
  const transaction = (operation: () => void) => {
    db.exec('BEGIN');
    try { operation(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, sql, query, transaction };
}

test('stream batches preserve UTF-8, escaped JSON and separate thoughts within a bounded byte size', () => {
  const text = '\u0000"\\🙂正文'.repeat(5000), thoughts = '思考🙂'.repeat(5000);
  const batches = [...streamBatches('run', 'assistant', 0, 0, text, thoughts)];
  let snapshot = { seq: 0, messages: [message] };
  for (const [index, batch] of batches.entries()) {
    assert.ok(payloadBytes(validateBatch(batch)) <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
    assert.ok(!/[\uD800-\uDBFF]$/.test(batch.content) && !/[\uD800-\uDBFF]$/.test(batch.reasoning));
    snapshot = applyChange(snapshot, { type: 'append', seq: index + 1, ...batch });
  }
  assert.equal(snapshot.messages[0].content, text); assert.equal(snapshot.messages[0].reasoning, thoughts);
  assert.equal(snapshot.messages[0].durableOffset, batches.at(-1)!.endOffset);
  assert.throws(() => validateBatch({ ...batches[0], endOffset: batches[0].endOffset + 1 }), /size or offset/);
  assert.throws(() => validateBatch({ ...batches[0], content: '\u0000'.repeat(15_000) }), /size or offset/);
});

test('incremental replay is idempotent and rejects missing identity, sequence and offset boundaries', () => {
  const batch = [...streamBatches('run', 'assistant', 0, 0, '你好🙂', '想法')][0];
  const change = { type: 'append' as const, seq: 1, ...batch };
  const first = applyChange({ seq: 0, messages: [message] }, change);
  assert.equal(applyChange(first, change), first);
  assert.throws(() => applyChange(first, { ...change, seq: 2 }), /offset gap/);
  assert.throws(() => applyChange(first, { ...change, seq: 3 }), /sequence gap/);
  assert.throws(() => applyChange({ seq: 0, messages: [] }, change), /Missing streamed message/);
  assert.throws(() => applyChange({ seq: 0, messages: [{ ...message, runId: 'another' }] }, change), /identity mismatch/);
});

test('schema migration keeps old messages, in-flight tasks and full-message event sequences readable', () => {
  const { db, sql, query } = database();
  try {
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
      createdAt INTEGER NOT NULL, runId TEXT, parentId TEXT, revisionOf TEXT, error TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, assistantId TEXT NOT NULL,
      context TEXT NOT NULL, chunkSeq INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);`);
    query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'old', 'assistant', '旧正文', 'running', 1, 'old-run', 'user', null, null);
    query('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)', 'old-run', 'conversation', 'old', '[]', 7, 1);
    query('INSERT INTO events (payload) VALUES (?)', JSON.stringify([{ ...message, id: 'old', content: '旧正文' }]));
    initializeConversation(sql, false); initializeConversation(sql, false);
    const legacy = query('SELECT * FROM messages WHERE id = ?', 'old').one() as unknown as Message;
    assert.equal(new StreamJournal(query).materialize(legacy), legacy);
    assert.equal(legacy.content, '旧正文'); assert.equal(legacy.streamVersion, null);
    const retained = query<{ payload: string }>('SELECT payload FROM events WHERE seq = 1').one().payload;
    assert.equal(applyChange({ seq: 0, messages: [] }, { type: 'change', seq: 1, messages: JSON.parse(retained) }).messages[0].content, '旧正文');
    const run = query('SELECT * FROM runs WHERE id = ?', 'old-run').one();
    assert.equal(run.chunkSeq, 7); assert.equal(run.streamVersion, null);
    assert.equal(query<{ seq: number }>('SELECT MAX(seq) AS seq FROM events').one().seq, 1);
    query('INSERT INTO events (payload) VALUES (?)', '[]');
    assert.equal(query<{ seq: number }>('SELECT MAX(seq) AS seq FROM events').one().seq, 2);
  } finally { db.close(); }
});

test('SQLite journal survives a new reader, deduplicates batches and compacts only with the snapshot transaction', () => {
  const { db, sql, query, transaction } = database();
  try {
    initializeConversation(sql, false);
    query('INSERT INTO messages (id, role, content, reasoning, status, createdAt, runId, streamVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, '', '', message.status, 1, message.runId, STREAM_VERSION);
    const journal = new StreamJournal(query);
    const batches = [...streamBatches('run', 'assistant', 0, 0, '正文🙂'.repeat(2000), '思考\n'.repeat(2000))];
    for (const batch of batches) { assert.equal(journal.append(batch), true); assert.equal(journal.append(batch), false); }
    const conflict = { ...batches[0], content: '不同内容' };
    conflict.endOffset = conflict.startOffset + payloadBytes(batchPayload(conflict.content, conflict.reasoning));
    assert.throws(() => journal.append(conflict), /Conflicting stream batch/);
    assert.equal(query<{ content: string }>('SELECT content FROM messages').one().content, '', 'streaming never rewrites the full message');
    const full = new StreamJournal(query).materialize(message);
    assert.equal(full.content, '正文🙂'.repeat(2000)); assert.equal(full.reasoning, '思考\n'.repeat(2000));
    assert.throws(() => transaction(() => { journal.compact(full); throw new Error('Final status write failed'); }), /status write failed/);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_batches').one().count, batches.length);
    assert.equal(query<{ content: string }>('SELECT content FROM messages').one().content, '');
    transaction(() => { journal.compact(full); query('UPDATE messages SET status = ?', 'completed'); });
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_batches').one().count, 0);
    const stored = query('SELECT * FROM messages').one() as unknown as Message;
    assert.equal(stored.content, full.content); assert.equal(stored.reasoning, full.reasoning); assert.equal(stored.durableOffset, full.durableOffset);
  } finally { db.close(); }
});

test('journal replay rejects a gap rather than returning a partial result as complete', () => {
  const { db, sql, query } = database();
  try {
    initializeConversation(sql, false);
    const journal = new StreamJournal(query);
    const first = [...streamBatches('run', 'assistant', 0, 0, '第一批', '')][0];
    const second = [...streamBatches('run', 'assistant', 1, first.endOffset, '第二批', '')][0];
    journal.append(second);
    assert.throws(() => journal.materialize(message), /sequence gap|offset gap/);
  } finally { db.close(); }
});
