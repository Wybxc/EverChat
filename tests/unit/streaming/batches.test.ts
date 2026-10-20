import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { messageParts, messageText } from '../../../shared/conversation/content';
import { type Message } from '../../../shared/conversation/types';
import { applyChange } from '../../../shared/streaming/apply-change';
import {
  MAX_BATCH_BYTES,
  STREAM_VERSION,
  streamBatches,
  validateBatch,
} from '../../../shared/streaming/batches';
import { ProviderStream, encodeBytes } from '../../../shared/streaming/provider-stream';
import { initializeConversation } from '../../../worker/conversation/schema';
import type { SqlQuery } from '../../../worker/generation/metrics';

const message: Message = {
  id: 'assistant',
  role: 'assistant',
  parts: [],
  status: 'running',
  createdAt: 1,
  runId: 'run',
  parentId: 'user',
  revisionOf: null,
  error: null,
  streamVersion: STREAM_VERSION,
  durableOffset: 0,
  streamState: new ProviderStream('openai-chat', true).checkpoint(),
};

const descriptor = { protocol: 'openai-chat' as const };
const wire = (content: string, reasoning: string) =>
  new TextEncoder().encode(
    JSON.stringify({ type: 'text', text: content }) +
      '\n' +
      JSON.stringify({ type: 'reasoning', text: reasoning }) +
      '\n',
  );

function database() {
  const db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    statement: string,
    ...bindings: SqlStorageValue[]
  ) => {
    const prepared = db.prepare(statement);
    const rows = prepared.all(...(bindings as (string | number | null)[])) as T[];
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
  const sql = { exec: query } as unknown as SqlStorage;
  const transaction = (operation: () => void) => {
    db.exec('BEGIN');
    try {
      operation();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return { db, sql, query, transaction };
}

test('stream batches preserve UTF-8, escaped JSON and separate thoughts within a bounded byte size', () => {
  const text = '\u0000"\\🙂正文'.repeat(5000),
    thoughts = '思考🙂'.repeat(5000);
  const batches = [...streamBatches('run', 'assistant', 0, 0, wire(text, thoughts))];
  let snapshot = { seq: 0, messages: [message] };
  for (const [index, batch] of batches.entries()) {
    assert.ok(validateBatch(batch).length <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
    snapshot = applyChange(snapshot, {
      type: 'commit',
      seq: index + 1,
      runId: batch.runId,
      messageId: batch.messageId,
      batches: [batch],
    });
  }
  assert.equal(messageText(snapshot.messages[0]), text);
  assert.equal(messageText(snapshot.messages[0], 'reasoning'), thoughts);
  assert.equal(snapshot.messages[0].durableOffset, batches.at(-1)!.endOffset);
  assert.throws(
    () => validateBatch({ ...batches[0], endOffset: batches[0].endOffset + 1 }),
    /size or offset/,
  );
  assert.throws(
    () => validateBatch({ ...batches[0], data: encodeBytes(new Uint8Array(15_000)) }),
    /Invalid stream batch/,
  );
});

test('incremental replay is idempotent and rejects missing identity, sequence and offset boundaries', () => {
  const batch = [...streamBatches('run', 'assistant', 0, 0, wire('你好🙂', '想法'))][0];
  const change = {
    type: 'commit' as const,
    seq: 1,
    runId: batch.runId,
    messageId: batch.messageId,
    batches: [batch],
  };
  const first = applyChange({ seq: 0, messages: [message] }, change);
  assert.equal(applyChange(first, change), first);
  assert.throws(() => applyChange(first, { ...change, seq: 2 }), /offset gap/);
  assert.throws(() => applyChange(first, { ...change, seq: 3 }), /sequence gap/);
  assert.throws(() => applyChange({ seq: 0, messages: [] }, change), /Missing streamed message/);
  assert.throws(
    () => applyChange({ seq: 0, messages: [{ ...message, runId: 'another' }] }, change),
    /identity mismatch/,
  );
});

test('fresh schema initializes idempotently with the current executor and checkpoints', () => {
  const { db, sql, query } = database();
  try {
    initializeConversation(sql, false);
    initializeConversation(sql, false);
    query('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
    query(
      'INSERT INTO runs (id, conversationId, assistantId, context, updatedAt) VALUES (?, ?, ?, ?, ?)',
      'run',
      'conversation',
      'assistant',
      '[]',
      1,
    );
    assert.equal(query('SELECT * FROM runs').one().executor, 'do-v1');
    assert.equal(query('SELECT * FROM runs').one().cancelRequested, 0);
    assert.equal(query('SELECT * FROM runs').one().durableOffset, 0);
    assert.equal(query('SELECT * FROM runs').one().startedAt, null);
    assert.equal(
      query<{ count: number }>('SELECT COUNT(*) AS count FROM generation_checkpoints').one().count,
      0,
    );
    assert.deepEqual(
      query(
        "SELECT name FROM sqlite_master WHERE name IN ('stream_commits', 'tool_stream_commits')",
      ).toArray(),
      [],
    );
  } finally {
    db.close();
  }
});
