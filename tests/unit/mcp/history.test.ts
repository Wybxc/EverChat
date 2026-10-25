import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeConversation } from '../../../worker/conversation/schema';
import { ConversationState } from '../../../worker/conversation/state';
import { GenerationCheckpoints } from '../../../worker/streaming/checkpoints';
import {
  McpHistory,
  markdownRecords,
  type HistoryRecord,
  type HistoryPosition,
  type HistorySnapshot,
} from '../../../worker/mcp/history';
import { McpError } from '../../../worker/mcp/contracts';
import type { SqlQuery } from '../../../worker/generation/metrics';

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
  initializeConversation({ exec: query } as unknown as SqlStorage, false);
  const history = new McpHistory(query),
    journal = new GenerationCheckpoints(query),
    state = new ConversationState(query);
  const add = (
    role: 'user' | 'assistant',
    text: string,
    parentId: string | null = null,
    status = 'completed',
  ) => {
    const id = crypto.randomUUID();
    query(
      'INSERT INTO messages(id,role,content,status,createdAt,parentId,model,modelName) VALUES(?,?,?,?,?,?,?,?)',
      id,
      role,
      text,
      status,
      Date.now(),
      parentId,
      role === 'assistant' ? 'gemini-test' : null,
      role === 'assistant' ? 'Gemini' : null,
    );
    state.advance([id]);
    return id;
  };
  return { db, query, history, journal, state, add };
}
test('MCP branch records preserve complete large messages, Unicode, turns, file metadata, exact summaries and Markdown without siblings', () => {
  const f = fixture();
  try {
    const question = f.add('user', '请审查'),
      text = 'a'.repeat(2047) + '😀' + '\n论证'.repeat(5000),
      answer = f.add('assistant', text, question);
    const sibling = f.add('assistant', 'EXCLUDED_SIBLING', question);
    const follow = f.add('user', '继续', answer),
      head = f.add('assistant', '完成', follow);
    const summary = f.add('assistant', '摘要', answer),
      otherSummary = f.add('assistant', 'EXCLUDED_SUMMARY', sibling);
    f.query(
      'INSERT INTO message_summaries VALUES(?,?)',
      summary,
      JSON.stringify({ sourceIds: [question, answer], throughId: answer }),
    );
    f.query(
      'INSERT INTO message_summaries VALUES(?,?)',
      otherSummary,
      JSON.stringify({ sourceIds: [question, sibling], throughId: sibling }),
    );
    const attachment = {
      type: 'file',
      name: '稿件😀.typ',
      textSha256: 'a'.repeat(64),
      selection: {
        ranges: Array.from({ length: 1000 }, (_, i) => ({ start: i * 3, end: i * 3 + 1 })),
      },
    };
    f.query('INSERT INTO message_files VALUES(?,?)', question, JSON.stringify([attachment]));
    const records: HistoryRecord[] = [];
    let position: HistoryPosition | undefined, snapshot: HistorySnapshot | undefined;
    do {
      const page = f.history.read('conversation', head, {
        position,
        snapshot,
        includeReasoning: true,
        includeTools: true,
        includeActive: false,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 30 * 1024);
      for (const record of page.records)
        if (record.kind === 'text')
          assert.equal(
            new TextDecoder().decode(new TextEncoder().encode(record.text)),
            record.text,
          );
      records.push(...page.records);
      snapshot = page.snapshot;
      position = page.position ?? undefined;
    } while (position);
    const messages = records.filter((r) => r.kind === 'message');
    assert.deepEqual(
      messages.map((r) => r.id),
      [question, answer, summary, follow, head],
    );
    assert.deepEqual(
      messages.map((r) => r.round),
      [1, 1, 1, 2, 2],
    );
    assert.equal(
      records
        .filter((r) => r.kind === 'text' && r.messageId === answer && r.channel === 'content')
        .map((r) => (r.kind === 'text' ? r.text : ''))
        .join(''),
      text,
    );
    assert.deepEqual(
      JSON.parse(
        records
          .filter((r) => r.kind === 'attachment')
          .map((r) => (r.kind === 'attachment' ? r.json : ''))
          .join(''),
      ),
      attachment,
    );
    const markdown = markdownRecords(records);
    assert.ok(markdown.includes('Gemini'));
    assert.ok(markdown.includes('稿件😀.typ'));
    assert.ok(!markdown.includes('EXCLUDED'));
    const ranged = f.history.read('conversation', head, {
      includeReasoning: false,
      includeTools: false,
      includeActive: false,
      fromRound: 2,
      toRound: 2,
    });
    assert.ok(ranged.records.every((r) => r.kind !== 'message' || r.round === 2));
    const oldSnapshot = snapshot!;
    f.state.advance([head]);
    assert.throws(
      () =>
        f.history.read('conversation', head, {
          snapshot: oldSnapshot,
          includeReasoning: false,
          includeTools: false,
          includeActive: false,
        }),
      (e) => e instanceof McpError && e.detail.code === 'SNAPSHOT_CHANGED',
    );
  } finally {
    f.db.close();
  }
});
test('MCP branch reads label active watermarks and erase deleted text instead of treating it as current content', () => {
  const f = fixture();
  try {
    const question = f.add('user', 'private old question'),
      head = f.add('assistant', 'saved partial', question, 'running');
    const options = { includeReasoning: false, includeTools: false, includeActive: false };
    assert.throws(
      () => f.history.read('conversation', head, options),
      (e) => e instanceof McpError && e.detail.code === 'BRANCH_ACTIVE',
    );
    assert.equal(
      f.history.read('conversation', head, { ...options, includeActive: true }).partial,
      true,
    );
    f.query('UPDATE messages SET status=? WHERE id=?', 'completed', head);
    f.query('INSERT INTO message_deletions VALUES(?,?)', question, Date.now());
    const page = f.history.read('conversation', head, options);
    assert.ok(!JSON.stringify(page).includes('private old question'));
    assert.ok(page.records.some((r) => r.kind === 'message' && r.id === question && r.deleted));
    const branches = f.history.branches(0);
    assert.deepEqual(
      branches.heads.map((r) => r.id),
      [head],
    );
  } finally {
    f.db.close();
  }
});
