import { messageParts, messageText } from '../shared/conversation/content';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeConversation } from '../worker/conversation-schema';
import { StreamJournal } from '../worker/stream-journal';
import { MAX_BATCH_BYTES, STREAM_VERSION, streamBatches, validateBatch } from '../shared/streaming/batches';
import { ProviderStream, encodeBytes } from '../shared/streaming/provider-stream';
import { applyChange } from '../shared/streaming/apply-change';
import { type Message } from '../shared/conversation/types';
import type { SqlQuery } from '../worker/generation-metrics';

const message: Message = { id: 'assistant', role: 'assistant', parts: [], status: 'running', createdAt: 1,
  runId: 'run', parentId: 'user', revisionOf: null, error: null, streamVersion: STREAM_VERSION, durableOffset: 0,
  streamState: new ProviderStream('openai-chat', true).checkpoint() };

const descriptor = { protocol: 'openai-chat' as const, showReasoning: true };
const wire = (content: string, reasoning: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning } }] })}\n\n`);

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
  const batches = [...streamBatches('run', 'assistant', 0, 0, wire(text, thoughts))];
  let snapshot = { seq: 0, messages: [message] };
  for (const [index, batch] of batches.entries()) {
    assert.ok(validateBatch(batch).length <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
    snapshot = applyChange(snapshot, { type: 'commit', seq: index + 1, runId: batch.runId, messageId: batch.messageId, batches: [batch] });
  }
  assert.equal(messageText(snapshot.messages[0]), text); assert.equal(messageText(snapshot.messages[0], 'reasoning'), thoughts);
  assert.equal(snapshot.messages[0].durableOffset, batches.at(-1)!.endOffset);
  assert.throws(() => validateBatch({ ...batches[0], endOffset: batches[0].endOffset + 1 }), /size or offset/);
  assert.throws(() => validateBatch({ ...batches[0], data: encodeBytes(new Uint8Array(15_000)) }), /Invalid stream batch/);
});

test('incremental replay is idempotent and rejects missing identity, sequence and offset boundaries', () => {
  const batch = [...streamBatches('run', 'assistant', 0, 0, wire('你好🙂', '想法'))][0];
  const change = { type: 'commit' as const, seq: 1, runId: batch.runId, messageId: batch.messageId, batches: [batch] };
  const first = applyChange({ seq: 0, messages: [message] }, change);
  assert.equal(applyChange(first, change), first);
  assert.throws(() => applyChange(first, { ...change, seq: 2 }), /offset gap/);
  assert.throws(() => applyChange(first, { ...change, seq: 3 }), /sequence gap/);
  assert.throws(() => applyChange({ seq: 0, messages: [] }, change), /Missing streamed message/);
  assert.throws(() => applyChange({ seq: 0, messages: [{ ...message, runId: 'another' }] }, change), /identity mismatch/);
});

test('fresh schema initializes idempotently with the current executor and stream journal', () => {
  const { db, sql, query } = database();
  try {
    initializeConversation(sql, false); initializeConversation(sql, false);
    query('INSERT INTO runs (id, conversationId, assistantId, context, updatedAt) VALUES (?, ?, ?, ?, ?)', 'run', 'conversation', 'assistant', '[]', 1);
    assert.equal(query('SELECT * FROM runs').one().executor, 'do-v1');
    assert.equal(query('SELECT * FROM runs').one().cancelRequested, 0);
    assert.equal(query('SELECT * FROM runs').one().durableOffset, 0);
    assert.equal(query('SELECT * FROM runs').one().startedAt, null);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, 0);
  } finally { db.close(); }
});

test('SQLite journal survives a new reader, deduplicates batches and compacts only with the snapshot transaction', () => {
  const { db, sql, query, transaction } = database();
  try {
    initializeConversation(sql, false);
    query('INSERT INTO messages (id, role, content, reasoning, status, createdAt, runId, streamVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, '', '', message.status, 1, message.runId, STREAM_VERSION);
    const journal = new StreamJournal(query);
    const batches = [...streamBatches('run', 'assistant', 0, 0, wire('正文🙂'.repeat(2000), '思考\n'.repeat(2000)))];
    const commits = batches.map((batch) => ({ runId: batch.runId, messageId: batch.messageId, batches: [batch] }));
    for (const commit of commits) { assert.equal(journal.append(commit), true); assert.equal(journal.append(commit), false); }
    const data = wire('不同内容', '');
    const conflict = { ...batches[0], data: encodeBytes(data), endOffset: data.length };
    assert.throws(() => journal.append({ runId: conflict.runId, messageId: conflict.messageId, batches: [conflict] }), /Conflicting stream commit/);
    assert.equal(query<{ content: string }>('SELECT content FROM messages').one().content, '', 'streaming never rewrites the full message');
    const full = new StreamJournal(query).materialize(message, descriptor);
    assert.equal(messageText(full), '正文🙂'.repeat(2000)); assert.equal(messageText(full, 'reasoning'), '思考\n'.repeat(2000));
    assert.throws(() => transaction(() => { journal.compact(full); throw new Error('Final status write failed'); }), /status write failed/);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, batches.length);
    assert.equal(query<{ content: string }>('SELECT content FROM messages').one().content, '');
    transaction(() => { journal.compact(full); query('UPDATE messages SET status = ?', 'completed'); });
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, 0);
    const stored = query<{ content: string; reasoning: string; durableOffset: number }>('SELECT * FROM messages').one();
    assert.deepEqual(messageParts(stored.content, stored.reasoning), full.parts); assert.equal(stored.durableOffset, full.durableOffset);
  } finally { db.close(); }
});

test('journal replay rejects a gap rather than returning a partial result as complete', () => {
  const { db, sql, query } = database();
  try {
    initializeConversation(sql, false);
    const journal = new StreamJournal(query);
    const first = [...streamBatches('run', 'assistant', 0, 0, wire('第一批', ''))][0];
    const second = [...streamBatches('run', 'assistant', 1, first.endOffset, wire('第二批', ''))][0];
    journal.append({ runId: second.runId, messageId: second.messageId, batches: [second] });
    assert.throws(() => journal.materialize(message, descriptor), /sequence gap|offset gap/);
  } finally { db.close(); }
});


test('a grouped commit persists once, replays every boundary and rolls back with a failed event write', () => {
  const { db, sql, query, transaction } = database();
  try {
    initializeConversation(sql, false);
    const first = [...streamBatches('run', 'assistant', 0, 0, wire('首段🙂', '思考'))][0];
    const second = [...streamBatches('run', 'assistant', 1, first.endOffset, wire('末段', '结论'))][0];
    const commit = { runId: 'run', messageId: 'assistant', batches: [first, second] };
    const journal = new StreamJournal(query);
    assert.throws(() => transaction(() => { journal.append(commit); query('INSERT INTO events (payload) VALUES (?)', JSON.stringify(commit)); throw new Error('Commit failure'); }), /Commit failure/);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, 0);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM events').one().count, 0);
    transaction(() => { journal.append(commit); query('INSERT INTO events (payload) VALUES (?)', JSON.stringify(commit)); });
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, 1);
    assert.equal(messageText(journal.materialize(message, descriptor)), '首段🙂末段');
    assert.equal(messageText(journal.materialize(message, descriptor), 'reasoning'), '思考结论');
    assert.throws(() => journal.append({ ...commit, batches: [first, { ...second, chunkSeq: 3 }] }), /gap/);
  } finally { db.close(); }
});

test('each model round appends to its saved display prefix while private replay remains separate and validates identities', async () => {
  const { db, sql, query } = database();
  try {
    initializeConversation(sql, false);
    const prefix = { ...message, parts: messageParts('上一轮🙂\n', '先前思考\n') };
    query('INSERT INTO messages (id, role, content, reasoning, status, createdAt, runId, streamVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, messageText(prefix), messageText(prefix, 'reasoning'), message.status, 1, message.runId, STREAM_VERSION);
    const display = new StreamJournal(query), privateJournal = new StreamJournal(query, 'tool_stream_commits');
    const raw = new TextEncoder().encode('private signature 🙂'.repeat(2000));
    const batches = [...streamBatches('run', 'assistant', 0, 0, raw)];
    privateJournal.append({ runId: 'run', messageId: 'assistant', batches });
    display.append({ runId: 'run', messageId: 'assistant', batches: [...streamBatches('run', 'assistant', 0, 0, wire('新正文', '新思考'))] });
    const current = display.materialize(prefix, descriptor);
    assert.equal(messageText(current), '上一轮🙂\n新正文'); assert.equal(messageText(current, 'reasoning'), '先前思考\n新思考');
    assert.equal(messageText(new StreamJournal(query).materialize(prefix, descriptor)), messageText(current));
    assert.deepEqual(new Uint8Array(await new Response(new StreamJournal(query, 'tool_stream_commits').replay('run', 'assistant')).arrayBuffer()), raw);
    display.compact(current);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM stream_commits').one().count, 0);
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM tool_stream_commits').one().count, 1);
    await assert.rejects(async () => new Response(privateJournal.replay('run', 'different')).arrayBuffer(), /identity/);
    query('UPDATE tool_stream_commits SET endOffset = endOffset + 1');
    assert.throws(() => privateJournal.replay('run', 'assistant'), /boundary/);
    privateJournal.purge('run');
    privateJournal.append({ runId: 'run', messageId: 'assistant', batches: batches.slice(1) });
    await assert.rejects(async () => new Response(privateJournal.replay('run', 'assistant')).arrayBuffer(), /boundary/);
    privateJournal.purge('run');
    assert.equal(query<{ count: number }>('SELECT COUNT(*) AS count FROM tool_stream_commits').one().count, 0);
  } finally { db.close(); }
});
