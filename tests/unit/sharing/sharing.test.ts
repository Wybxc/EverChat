import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../../shared/conversation/types';
import { messageParts } from '../../../shared/conversation/content';
import { projectShare } from '../../../shared/sharing/projection';
import { SHARING_SCHEMA } from '../../../worker/sharing/schema';
import { ShareRepository, publicShare } from '../../../worker/sharing/store';
import type { SqlQuery } from '../../../worker/generation/metrics';

const message = (id: string, parentId: string | null = null): Message => ({
  id,
  parentId,
  role: parentId ? 'assistant' : 'user',
  status: 'completed',
  parts: messageParts(`正文 ${id}`, `思考 ${id}`),
  createdAt: 1,
  runId: 'private-run',
  revisionOf: null,
  error: 'private-error',
  model: 'private-model',
  providerId: 'private-provider',
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(SHARING_SCHEMA);
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
  let time = 1000;
  const store = new ShareRepository(query, () => time);
  const draft = (operationId = 'operation') => {
    const row = store.begin({
      operationId,
      conversationId: 'conversation',
      headId: 'a',
      title: '分享',
    });
    store.append(row.id, 0, {
      message: 0,
      role: 'user',
      channel: 'text',
      text: 'hello',
      omittedAttachments: 0,
    });
    store.finishDraft(row.id, 'version1', 1, 1, 0, 'hash');
    store.saveHtml(row.id, ['<p>hello</p>']);
    return store.get(row.id)!;
  };
  return {
    db,
    store,
    draft,
    tick: (t: number) => {
      time = t;
    },
  };
}
test('share projection exposes only the selected completed branch, always including reasoning', () => {
  const a = message('a'),
    b = message('b', 'a'),
    c = message('other-branch', 'a');
  const summary = { ...message('summary', 'a'), summary: { sourceIds: ['a'] } } as Message;
  const projected = projectShare([a, b, c, summary], 'b');
  const blocks = [...projected.blocks()];
  assert.equal(projected.messageCount, 2);
  assert.deepEqual(
    blocks.filter((b) => b.channel === 'text').map((b) => b.text),
    ['正文 a', '正文 b'],
  );
  assert.doesNotMatch(
    JSON.stringify(blocks),
    /private-run|private-error|private-provider|other-branch|sourceIds/,
  );
  assert.equal(blocks.find((block) => block.role === 'assistant')?.modelName, 'private-model');
  assert.deepEqual(
    blocks.filter((b) => b.channel === 'reasoning').map((b) => b.text),
    ['思考 a', '思考 b'],
  );
  assert.throws(() => projectShare([a, { ...b, status: 'running' }], 'b'));
  assert.throws(() => projectShare([{ ...a, deletedAt: 10 }, b], 'b'));
});
test('share snapshots retain each answer model display name without provider metadata or repeated names per block', () => {
  const user = message('user'),
    answer = {
      ...message('answer', 'user'),
      modelName: 'Flash 显示名',
      parts: messageParts('正文'.repeat(20000), '思考'),
    };
  const blocks = [...projectShare([user, answer], 'answer').blocks()];
  assert.equal(blocks.filter((block) => block.modelName !== undefined).length, 1);
  assert.equal(blocks.find((block) => block.role === 'assistant')?.modelName, 'Flash 显示名');
  assert.ok(
    blocks.filter((block) => block.role === 'user').every((block) => block.modelName === undefined),
  );
  assert.doesNotMatch(
    JSON.stringify(blocks),
    /private-model|private-provider|providerId|providerName/,
  );
});
test('large public messages split below SQLite/RPC limits without corrupting surrogate pairs', () => {
  const text = '😀'.repeat(40_000),
    a = { ...message('a'), parts: messageParts(text) };
  const blocks = [...projectShare([a], 'a').blocks()];
  assert.ok(blocks.length > 4);
  assert.equal(blocks.map((b) => b.text).join(''), text);
  for (const block of blocks)
    assert.equal(block.text, new TextDecoder().decode(new TextEncoder().encode(block.text)));
});
test('publication is public, idempotent, has no expiry, and deletion removes snapshots and HTML', () => {
  const s = fixture();
  try {
    const row = s.draft();
    assert.throws(() => s.store.published(row.id));
    s.store.publish(row.id, 'hash', '公开标题');
    assert.equal(s.store.published(row.id).title, '公开标题');
    s.store.publish(row.id, 'hash', 'changed-on-retry');
    assert.equal(s.store.published(row.id).title, '公开标题');
    s.tick(1000 + 365 * 86_400_000);
    assert.equal(s.store.published(row.id).expiresAt, null);
    s.store.delete(row.id);
    assert.throws(() => s.store.published(row.id));
    assert.equal(s.store.get(row.id), undefined);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM share_blocks').get()!.n, 0);
    assert.equal(s.store.list().shares.length, 0);
    s.store.delete(row.id); // Retrying a successful deletion is safe.
    assert.doesNotMatch(JSON.stringify(s.store.list()), /tokenHash|tokenCipher|cipher/);
  } finally {
    s.db.close();
  }
});
test('legacy expired links never revive and conversation deletion removes all snapshots and in-flight drafts', () => {
  const s = fixture();
  try {
    const row = s.draft();
    s.store.publish(row.id, 'hash', '标题');
    s.db.prepare('UPDATE shares SET expiresAt=? WHERE id=?').run(1000 + 86_400_000, row.id);
    s.tick(1000 + 86_400_000);
    assert.equal(s.store.list().shares[0].status, 'expired');
    assert.throws(() => s.store.published(row.id));
    const pending = s.draft('operation2');
    s.store.deleteConversation('conversation');
    assert.throws(() => s.store.publish(pending.id, 'hash', '标题'));
    assert.throws(() =>
      s.store.begin({
        operationId: 'new',
        conversationId: 'conversation',
        headId: 'a',
        title: '标题',
      }),
    );
    s.store.cleanup();
    assert.equal(s.store.get(row.id), undefined);
    assert.equal(s.store.get(pending.id), undefined);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM share_blocks').get()!.n, 0);
  } finally {
    s.db.close();
  }
});
test('optional expiry rejects reads and retries at the deadline and physically removes the snapshot', () => {
  const s = fixture();
  try {
    const row = s.draft();
    const published = s.store.publish(row.id, 'hash', '限时分享', 2000);
    assert.equal(publicShare(published).expiresAt, 2000);
    assert.equal(s.store.nextCleanup(), 2000);
    s.store.publish(row.id, 'hash', '重复请求', null);
    assert.equal(s.store.published(row.id).expiresAt, 2000);
    s.tick(1999);
    assert.equal(s.store.published(row.id).id, row.id);
    s.tick(2000);
    assert.throws(() => s.store.published(row.id));
    assert.throws(() => s.store.publish(row.id, 'hash', '重试', 3000));
    s.store.cleanup();
    assert.equal(s.store.get(row.id), undefined);
    assert.equal(s.store.list().shares.length, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM share_blocks').get()!.n, 0);
    assert.equal(s.store.nextCleanup(), null);
  } finally {
    s.db.close();
  }
});
test('expired large snapshots are reclaimed in bounded alarm batches without removing permanent shares', () => {
  const s = fixture();
  try {
    const row = s.draft();
    for (let seq = 1; seq < 129; seq++)
      s.store.append(row.id, seq, {
        message: 0,
        role: 'user',
        channel: 'text',
        text: '内容',
        omittedAttachments: 0,
      });
    s.store.finishDraft(row.id, 'version1', 1, 129, 0, 'hash');
    s.store.publish(row.id, 'hash', '大快照', 2000);
    const permanent = s.draft('permanent');
    s.store.publish(permanent.id, 'hash', '永久分享');
    s.tick(2000);
    s.store.cleanup();
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM share_blocks WHERE shareId=?').get(row.id)!.n,
      1,
    );
    assert.equal(s.store.nextCleanup(), 3000);
    s.store.cleanup();
    assert.equal(s.store.get(row.id), undefined);
    assert.equal(s.store.published(permanent.id).id, permanent.id);
    assert.equal(s.store.nextCleanup(), null);
  } finally {
    s.db.close();
  }
});
test('publication rejects invalid or past expiry without changing the draft', () => {
  const s = fixture();
  try {
    const row = s.draft();
    for (const expiresAt of [NaN, Infinity, -1, 0, 1000, 1000.5, 8_640_000_000_000_001]) {
      assert.throws(() => s.store.publish(row.id, 'hash', '标题', expiresAt));
      assert.equal(s.store.get(row.id)!.status, 'draft');
    }
  } finally {
    s.db.close();
  }
});
test('incomplete snapshots cannot publish; paging and cleanup preserve active immutable content', () => {
  const s = fixture();
  try {
    const row = s.draft();
    s.store.finishDraft(row.id, 'v', 1, 9, 0, 'hash');
    assert.throws(() => s.store.publish(row.id, 'hash', '标题'));
    for (let seq = 1; seq < 9; seq++)
      s.store.append(row.id, seq, {
        message: 0,
        role: 'user',
        channel: 'text',
        text: String(seq),
        omittedAttachments: 0,
      });
    s.store.publish(row.id, 'hash', '标题');
    s.store.cleanup();
    const first = s.store.page(s.store.published(row.id));
    assert.equal(first.blocks.length, 4);
    assert.equal(first.cursor, 4);
    assert.equal(s.store.page(s.store.published(row.id), 8).cursor, null);
    assert.throws(() => s.store.page(row, 9));
    s.store.delete(row.id);
    assert.equal(s.store.get(row.id), undefined);
  } finally {
    s.db.close();
  }
});
