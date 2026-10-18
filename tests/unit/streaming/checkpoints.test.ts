import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { messageParts, messageText } from '../../../shared/conversation/content';
import type { Message } from '../../../shared/conversation/types';
import { streamBatches, STREAM_VERSION } from '../../../shared/streaming/batches';
import { initializeConversation } from '../../../worker/conversation/schema';
import { ConversationMessages } from '../../../worker/conversation/messages';
import { ConversationState, requestFingerprint } from '../../../worker/conversation/state';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { GenerationCheckpoints } from '../../../worker/streaming/checkpoints';
import { STREAM_JOURNAL_SCHEMA } from '../../../worker/streaming/journal';
import { migrateStorage } from '../../../scripts/operations/migrate-storage';

function fixture() {
  const db = new DatabaseSync(':memory:');
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
  const sql = { exec: query } as unknown as SqlStorage;
  initializeConversation(sql, false);
  const journal = new GenerationCheckpoints(query);
  const messages = new ConversationMessages(
    query,
    journal,
    () => JSON.stringify({ provider: 'openai-chat' }),
    () => {},
  );
  const message: Message = {
    id: 'a',
    role: 'assistant',
    parts: [],
    status: 'running',
    createdAt: 1,
    runId: 'r',
    parentId: null,
    revisionOf: null,
    error: null,
    streamVersion: STREAM_VERSION,
    durableOffset: 0,
  };
  messages.insert(message);
  return { db, query, sql, journal, messages, message };
}
const wire = (text: string, reasoning = '') =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text, reasoning_content: reasoning } }] })}\n\n`,
  );

test('context reads only the selected parent path and applicable summaries, retaining the full graph for admission', () => {
  const f = fixture();
  try {
    const add = (id: string, parentId: string | null, summary?: Message['summary']) => {
      const message: Message = {
        ...f.message,
        id,
        parentId,
        runId: null,
        status: 'completed',
        parts: messageParts(`${id}-body`),
        ...(summary ? { summary } : {}),
      };
      f.messages.insert(message);
      f.journal.compact(message);
    };
    add('root', null);
    add('chosen', 'root');
    add('other', 'root');
    add('chosen-summary', 'chosen', { throughId: 'chosen', sourceIds: ['root', 'chosen'] });
    add('other-summary', 'other', { throughId: 'other', sourceIds: ['root', 'other'] });
    const read = f.journal.read.bind(f.journal),
      loaded: string[] = [];
    f.journal.read = (id, ...args) => {
      loaded.push(id);
      return read(id, ...args);
    };
    const graph = f.messages.forHead('chosen');
    assert.equal(graph.length, f.messages.count());
    assert.deepEqual(loaded.sort(), ['chosen', 'chosen-summary', 'root']);
    assert.equal(messageText(graph.find(({ id }) => id === 'chosen')!), 'chosen-body');
    assert.equal(messageText(graph.find(({ id }) => id === 'other')!), '');
    assert.equal(graph.find(({ id }) => id === 'other')!.parentId, 'root');
    loaded.length = 0;
    assert.equal(f.messages.forHead(null).length, graph.length);
    assert.equal(f.messages.forHead('missing').length, graph.length);
    assert.deepEqual(loaded, []);
  } finally {
    f.db.close();
  }
});

test('canonical checkpoints recover split UTF-8 and SSE across restarts without a persistent wire log', () => {
  const f = fixture();
  try {
    const text = '🙂正文'.repeat(3000),
      reasoning = '思考'.repeat(3000),
      raw = wire(text, reasoning);
    let seq = 0,
      offset = 0;
    for (let i = 0; i < raw.length; i += 113) {
      const batches = [...streamBatches('r', 'a', seq, offset, raw.slice(i, i + 113))];
      // Every checkpoint gets a cold decoder, including unfinished multibyte input.
      new GenerationCheckpoints(f.query).append(
        { runId: 'r', messageId: 'a', batches },
        { protocol: 'openai-chat' },
      );
      seq = batches.at(-1)!.chunkSeq;
      offset = batches.at(-1)!.endOffset;
    }
    const saved = f.messages.message('a')!;
    assert.equal(messageText(saved), text);
    assert.equal(messageText(saved, 'reasoning'), reasoning);
    assert.equal(saved.durableOffset, raw.length);
    assert.equal(f.query('SELECT * FROM generation_checkpoints').toArray().length, 1);
    assert.equal(
      f.query("SELECT name FROM sqlite_master WHERE name IN ('events','stream_commits')").toArray()
        .length,
      0,
    );
    const finished = { ...saved, status: 'completed' as const };
    f.journal.compact(finished);
    assert.equal(f.query('SELECT * FROM generation_checkpoints').toArray().length, 0);
    assert.equal(f.journal.read('a').content, text);
    assert.equal(f.query<{ content: string }>('SELECT content FROM messages').one().content, '');
    assert.ok(f.query('SELECT * FROM message_content_chunks').toArray().length < 20);
  } finally {
    f.db.close();
  }
});

test('rollback discards the decoder and retry saves exactly once; canonical chunks preserve surrogate boundaries', () => {
  const f = fixture();
  try {
    const prefix = 'x'.repeat(4095) + '🙂';
    const first = [...streamBatches('r', 'a', 0, 0, wire(prefix, '思考'))];
    const commit = { runId: 'r', messageId: 'a', batches: first };
    f.db.exec('BEGIN');
    f.journal.append(commit, { protocol: 'openai-chat' });
    f.db.exec('ROLLBACK');
    f.journal.forget('r');
    assert.equal(f.journal.append(commit, { protocol: 'openai-chat' }), true);
    assert.equal(f.journal.append(commit), false);
    const last = first.at(-1)!;
    const second = [
      ...streamBatches('r', 'a', last.chunkSeq, last.endOffset, wire('末尾', '结束')),
    ];
    f.journal.append({ ...commit, batches: second });
    assert.deepEqual(f.journal.read('a'), { content: prefix + '末尾', reasoning: '思考结束' });
    f.journal.erase('a');
    assert.deepEqual(f.journal.read('a'), { content: '', reasoning: '' });
  } finally {
    f.db.close();
  }
});

test('offline operations remove wire and event duplicates while preserving prefixes, versions and idempotency', () => {
  const f = fixture();
  try {
    f.query('DROP TABLE conversation_state');
    f.query('DROP TABLE message_versions');
    f.query('CREATE TABLE events(seq INTEGER PRIMARY KEY, payload TEXT)');
    f.query('INSERT INTO events VALUES (501, ?)', 'old notification');
    f.query(
      'INSERT INTO submissions VALUES (?, ?, ?)',
      'request',
      JSON.stringify(['input', '正文']),
      '{}',
    );
    f.query(
      'INSERT INTO runs(id,conversationId,assistantId,context,updatedAt,config) VALUES (?, ?, ?, ?, ?, ?)',
      'r',
      'c',
      'a',
      '[]',
      1,
      JSON.stringify({ provider: 'openai-chat' }),
    );
    f.query(STREAM_JOURNAL_SCHEMA);
    const batches = [...streamBatches('r', 'a', 0, 0, wire('已保存正文', '已保存思考'))];
    const first = batches[0],
      last = batches.at(-1)!;
    f.query(
      'INSERT INTO stream_commits VALUES (?, ?, ?, ?, ?, ?)',
      'r',
      first.chunkSeq,
      last.chunkSeq,
      first.startOffset,
      last.endOffset,
      JSON.stringify(batches),
    );
    migrateStorage(f.db, 'conversation');
    migrateStorage(f.db, 'conversation');
    assert.equal(f.messages.seq(), 501);
    assert.equal(f.messages.changes(0).messages[0].id, 'a');
    assert.equal(messageText(f.messages.message('a')!), '已保存正文');
    assert.equal(
      f.query('SELECT fingerprint FROM submissions').one().fingerprint,
      requestFingerprint(['input', '正文']),
    );
    assert.equal(
      f.query("SELECT name FROM sqlite_master WHERE name IN ('events','stream_commits')").toArray()
        .length,
      0,
    );
  } finally {
    f.db.close();
  }
});

test('latest state versions collapse notifications and retain tombstones for disconnected readers', () => {
  const f = fixture();
  try {
    const state = new ConversationState(f.query),
      epoch = state.current().epoch;
    for (let i = 0; i < 100; i++) f.messages.advance(['a']);
    assert.equal(f.messages.changes(1).seq, 100);
    assert.equal(f.messages.changes(1).epoch, epoch);
    assert.equal(f.messages.changes(1).messages.length, 1);
    f.query('INSERT INTO message_deletions VALUES (?, ?)', 'a', 2);
    f.query('UPDATE messages SET content = ?, reasoning = ? WHERE id = ?', '', '', 'a');
    f.messages.advance(['a']);
    assert.equal(f.messages.changes(100).messages[0].deletedAt, 2);
    assert.deepEqual(f.messages.changes(100).messages[0].parts, []);
    assert.equal(f.query('SELECT * FROM message_versions').toArray().length, 1);
    assert.equal(requestFingerprint('x'.repeat(100000)).length, 64);
  } finally {
    f.db.close();
  }
});

test('ten sibling versions retain semantic content once and stay below the former early database ceiling', () => {
  const f = fixture();
  try {
    const frame = new TextDecoder().decode(wire('', '思考'));
    const bytes = new TextEncoder().encode(frame.repeat(8000));
    for (let version = 0; version < 10; version++) {
      const id = `version-${version}`,
        runId = `run-${version}`;
      f.messages.insert({
        ...f.message,
        id,
        runId,
        parentId: 'shared-user',
        revisionOf: version ? 'version-0' : null,
      });
      let seq = 0,
        offset = 0;
      for (let at = 0; at < bytes.length; at += 24 * 1024) {
        const batches = [
          ...streamBatches(runId, id, seq, offset, bytes.subarray(at, at + 24 * 1024)),
        ];
        f.journal.append({ runId, messageId: id, batches }, { protocol: 'openai-chat' });
        seq = batches.at(-1)!.chunkSeq;
        offset = batches.at(-1)!.endOffset;
        f.messages.advance([id]);
      }
      const saved = f.messages.message(id)!;
      assert.equal(messageText(saved, 'reasoning'), '思考'.repeat(8000));
      f.journal.compact(saved);
      f.query("UPDATE messages SET status = 'completed' WHERE id = ?", id);
    }
    const physical =
      (f.db.prepare('PRAGMA page_count').get()!.page_count as number) *
      (f.db.prepare('PRAGMA page_size').get()!.page_size as number);
    assert.ok(physical < 2 * 1024 * 1024, `ten versions allocated ${physical} bytes`);
    assert.equal(f.query('SELECT * FROM generation_checkpoints').toArray().length, 0);
    assert.equal(f.query('SELECT * FROM message_versions').toArray().length, 10);
    assert.equal(
      f.query("SELECT name FROM sqlite_master WHERE name IN ('events', 'stream_commits')").toArray()
        .length,
      0,
    );
  } finally {
    f.db.close();
  }
});
