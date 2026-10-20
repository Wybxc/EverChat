import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mergeActivity, type ConversationActivity } from '../../../shared/conversation/activity';
import { applyChange } from '../../../shared/streaming/apply-change';
import { ConversationActivityJournal } from '../../../worker/conversation/activity';
import { ConversationMessages } from '../../../worker/conversation/messages';
import { initializeConversation } from '../../../worker/conversation/schema';
import { LIBRARY_ACTIVITY_SCHEMA, LibraryActivityIndex } from '../../../worker/library/activity';
import { GenerationCheckpoints } from '../../../worker/streaming/checkpoints';
import type { SqlQuery } from '../../../worker/generation/metrics';

const conversationId = crypto.randomUUID(),
  messageId = crypto.randomUUID(),
  runId = crypto.randomUUID();
function database() {
  const db = new DatabaseSync(':memory:');
  let activityWrites = 0;
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...bindings: SqlStorageValue[]
  ) => {
    if (/^(INSERT INTO|UPDATE) conversation_activity/.test(sql)) activityWrites++;
    const rows = db.prepare(sql).all(...(bindings as (string | number | null)[])) as T[];
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
  return { db, query, writes: () => activityWrites };
}
function source() {
  const store = database();
  initializeConversation({ exec: store.query } as unknown as SqlStorage, false);
  let now = 1000;
  const activity = new ConversationActivityJournal(store.query, () => now);
  const messages = new ConversationMessages(
    store.query,
    new GenerationCheckpoints(store.query),
    () => null,
    () => {},
    activity,
  );
  store.query(
    'INSERT INTO messages(id, role, content, status, createdAt, runId) VALUES (?, ?, ?, ?, ?, ?)',
    messageId,
    'assistant',
    '',
    'queued',
    1,
    runId,
  );
  store.query(
    'INSERT INTO runs(id, conversationId, assistantId, context, updatedAt) VALUES (?, ?, ?, ?, ?)',
    runId,
    conversationId,
    messageId,
    '[]',
    1,
  );
  return {
    ...store,
    activity,
    messages,
    tick: (value: number) => (now = value),
    record: () => messages.record([messages.rawMessage(messageId)!], conversationId),
  };
}

test('activity is transactionally versioned only at lifecycle changes; raw byte events never write its index', () => {
  const s = source();
  try {
    const queued = s.record();
    assert.equal(queued.activity?.status, 'queued');
    assert.equal(queued.activity?.version, 1);
    s.query("UPDATE messages SET status = 'running' WHERE id = ?", messageId);
    const running = s.record();
    assert.equal(running.activity?.version, 2);
    assert.equal(s.record().activity, undefined);
    for (let i = 0; i < 200; i++) s.messages.advance([messageId]);
    assert.equal(s.writes(), 2);
    assert.equal(s.activity.snapshot()?.version, 2);
    s.db.exec('BEGIN');
    s.query("UPDATE messages SET status = 'failed' WHERE id = ?", messageId);
    assert.equal(s.record().activity?.status, 'idle');
    s.db.exec('ROLLBACK');
    assert.equal(s.activity.snapshot()?.version, 2);
    s.query('UPDATE runs SET cancelRequested = 1 WHERE id = ?', runId);
    assert.equal(s.record().activity?.status, 'stopping');
    s.query("UPDATE messages SET status = 'cancelled' WHERE id = ?", messageId);
    const idle = s.record();
    assert.deepEqual(idle.activity, { status: 'idle', version: 4, updatedAt: 1000 });
    assert.equal(s.messages.changes(running.seq).activity?.status, 'idle');
    assert.equal(
      s.query("SELECT name FROM sqlite_master WHERE name = 'events'").toArray().length,
      0,
    );
    const snapshot = s.messages.snapshot();
    const next = applyChange({ ...snapshot, seq: idle.seq - 1, activity: running.activity }, idle);
    assert.deepEqual(next.activity, idle.activity);
  } finally {
    s.db.close();
  }
});

test('automatic summaries and tool round changes keep a single active conversation target', () => {
  const s = source(),
    summaryId = crypto.randomUUID(),
    summaryRun = crypto.randomUUID();
  try {
    s.query(
      'INSERT INTO messages(id,role,content,status,createdAt,runId) VALUES (?, ?, ?, ?, ?, ?)',
      summaryId,
      'assistant',
      '',
      'running',
      0,
      summaryRun,
    );
    s.query(
      'INSERT INTO runs(id,conversationId,assistantId,context,updatedAt) VALUES (?, ?, ?, ?, ?)',
      summaryRun,
      conversationId,
      summaryId,
      '[]',
      1,
    );
    s.query('INSERT INTO message_summaries VALUES (?, ?)', summaryId, '{}');
    s.query('INSERT INTO run_dependencies VALUES (?, ?, ?, ?)', runId, summaryRun, summaryId, '{}');
    assert.deepEqual(s.record().activity, {
      status: 'running',
      messageId,
      runId,
      version: 1,
      updatedAt: 1000,
    });
    s.query("UPDATE messages SET status = 'completed' WHERE id = ?", summaryId);
    s.query('DELETE FROM run_dependencies');
    assert.equal(s.record().activity?.status, 'queued');
    s.query("UPDATE messages SET status = 'running' WHERE id = ?", messageId);
    assert.equal(s.record().activity?.status, 'running');
    assert.equal(s.record().activity, undefined);
    const nextRun = crypto.randomUUID();
    s.query(
      'INSERT INTO runs(id,conversationId,assistantId,context,updatedAt) VALUES (?, ?, ?, ?, ?)',
      nextRun,
      conversationId,
      messageId,
      '[]',
      1,
    );
    s.query('UPDATE messages SET runId = ? WHERE id = ?', nextRun, messageId);
    assert.deepEqual(s.record().activity, {
      status: 'running',
      messageId,
      runId: nextRun,
      version: 4,
      updatedAt: 1000,
    });
  } finally {
    s.db.close();
  }
});

test('a failed report retries durably and acknowledging an older version cannot erase a newer lifecycle report', async () => {
  const s = source();
  try {
    s.record();
    let calls = 0;
    await s.activity.flush(async () => {
      calls++;
      throw new Error('offline');
    });
    assert.equal(calls, 1);
    assert.equal(s.activity.nextAlarm(), 2000);
    const recovered = new ConversationActivityJournal(s.query, () => 2000);
    const delivered: number[] = [];
    await recovered.flush(async (id, activity) => {
      assert.equal(id, conversationId);
      delivered.push(activity.version);
      if (activity.version === 1) {
        s.query("UPDATE messages SET status = 'running' WHERE id = ?", messageId);
        s.tick(2000);
        s.record();
      }
    });
    assert.deepEqual(delivered, [1, 2]);
    assert.equal(recovered.nextAlarm(), null);
    assert.equal(recovered.snapshot()?.status, 'running');
  } finally {
    s.db.close();
  }
});

test('a deletion during an in-flight lifecycle report never recreates its erased outbox', async () => {
  const s = source();
  let live = true;
  try {
    s.record();
    const journal = new ConversationActivityJournal(
      s.query,
      () => 1000,
      () => live,
    );
    await journal.flush(async () => {
      live = false;
      s.query('DROP TABLE conversation_activity');
    });
    assert.equal(
      s.query("SELECT name FROM sqlite_master WHERE name = 'conversation_activity'").toArray()
        .length,
      0,
    );
  } finally {
    s.db.close();
  }
});

test('manual summary activity locates the covered branch while retaining its own cancellation run', () => {
  const s = source(),
    throughId = crypto.randomUUID();
  try {
    s.query(
      'INSERT INTO message_summaries VALUES (?, ?)',
      messageId,
      JSON.stringify({ throughId, sourceIds: [throughId] }),
    );
    assert.deepEqual(s.record().activity, {
      status: 'queued',
      messageId: throughId,
      runId,
      version: 1,
      updatedAt: 1000,
    });
  } finally {
    s.db.close();
  }
});

test('Library and client merges retain idle watermarks, reject stale tasks and never revive deleted conversations', () => {
  const s = database();
  try {
    s.query('CREATE TABLE conversations(id TEXT PRIMARY KEY, updatedAt INTEGER)');
    s.query('CREATE TABLE conversation_deletions(id TEXT PRIMARY KEY)');
    s.query(LIBRARY_ACTIVITY_SCHEMA);
    s.query('INSERT INTO conversations VALUES (?, ?)', conversationId, 99);
    const index = new LibraryActivityIndex(s.query);
    const running: ConversationActivity = {
      status: 'running',
      version: 2,
      updatedAt: 1,
      messageId,
      runId,
    };
    const idle: ConversationActivity = { status: 'idle', version: 3, updatedAt: 2 };
    index.accept(conversationId, idle);
    index.accept(conversationId, running);
    index.accept(conversationId, { ...running, version: 3 });
    assert.deepEqual(index.snapshot(), { [conversationId]: idle });
    assert.equal(
      s.query<{ updatedAt: number }>('SELECT updatedAt FROM conversations').one().updatedAt,
      99,
    );
    const cached = mergeActivity({}, conversationId, idle);
    assert.equal(mergeActivity(cached, conversationId, running), cached);
    assert.equal(mergeActivity(cached, conversationId, { ...running, version: NaN }), cached);
    s.query('INSERT INTO conversation_deletions VALUES (?)', conversationId);
    index.accept(conversationId, { ...running, version: 4 });
    assert.deepEqual(index.snapshot(), {});
    assert.throws(() =>
      index.accept(conversationId, { ...running, secret: 'private' } as ConversationActivity),
    );
  } finally {
    s.db.close();
  }
});
