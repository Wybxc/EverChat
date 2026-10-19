import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../../shared/conversation/types';
import { messageParts } from '../../../shared/conversation/content';
import { projectShare } from '../../../shared/sharing/projection';
import { SHARING_SCHEMA } from '../../../worker/sharing/schema';
import { ShareRepository } from '../../../worker/sharing/store';
import { publicShare } from '../../../worker/sharing/store';
import { snapshotResponse } from '../../../worker/sharing/response';
import {
  encryptToken,
  decryptToken,
  randomShareSecret,
  tokenHash,
} from '../../../worker/sharing/crypto';
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
test('link secrets are encrypted with record binding and wrong keys or swapped ciphertext are rejected', async () => {
  const token = randomShareSecret(),
    key = randomShareSecret();
  const encrypted = await encryptToken(token, key, 'share1');
  assert.ok(!encrypted.includes(token));
  assert.equal(await decryptToken(encrypted, key, 'share1'), token);
  await assert.rejects(decryptToken(encrypted, key, 'share2'));
  await assert.rejects(decryptToken(encrypted, randomShareSecret(), 'share1'));
});
test('publication is idempotent, has no expiry, and deletion removes both credentials and blocks', () => {
  const s = fixture();
  try {
    const row = s.draft();
    assert.throws(() => s.store.authorize(row.id, 'token'));
    s.store.publish(row.id, 'hash', '公开标题', tokenHash('token'), 'cipher');
    assert.equal(s.store.authorize(row.id, 'token').title, '公开标题');
    s.store.publish(row.id, 'hash', 'changed-on-retry', tokenHash('new'), 'newcipher');
    assert.equal(s.store.authorize(row.id, 'token').title, '公开标题');
    s.tick(1000 + 365 * 86_400_000);
    assert.equal(s.store.authorize(row.id, 'token').expiresAt, null);
    assert.throws(() => s.store.authorize(row.id, 'new'));
    s.store.delete(row.id);
    assert.throws(() => s.store.authorize(row.id, 'token'));
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
    s.store.publish(row.id, 'hash', '标题', tokenHash('token'), 'cipher');
    s.db.prepare('UPDATE shares SET expiresAt=? WHERE id=?').run(1000 + 86_400_000, row.id);
    s.tick(1000 + 86_400_000);
    assert.equal(s.store.list().shares[0].status, 'expired');
    assert.throws(() => s.store.authorize(row.id, 'token'));
    const pending = s.draft('operation2');
    s.store.deleteConversation('conversation');
    assert.throws(() => s.store.publish(pending.id, 'hash', '标题', tokenHash('token'), 'cipher'));
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
    const published = s.store.publish(
      row.id,
      'hash',
      '限时分享',
      tokenHash('token'),
      'cipher',
      2000,
    );
    assert.equal(publicShare(published).expiresAt, 2000);
    assert.equal(s.store.nextCleanup(), 2000);
    s.store.publish(row.id, 'hash', '重复请求', tokenHash('new'), 'newcipher', null);
    assert.equal(s.store.authorize(row.id, 'token').expiresAt, 2000);
    s.tick(1999);
    assert.equal(s.store.authorize(row.id, 'token').id, row.id);
    s.tick(2000);
    assert.throws(() => s.store.authorize(row.id, 'token'));
    assert.throws(() =>
      s.store.publish(row.id, 'hash', '重试', tokenHash('token'), 'cipher', 3000),
    );
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
    s.store.publish(row.id, 'hash', '大快照', tokenHash('token'), 'cipher', 2000);
    const permanent = s.draft('permanent');
    s.store.publish(permanent.id, 'hash', '永久分享', tokenHash('keep'), 'cipher');
    s.tick(2000);
    s.store.cleanup();
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM share_blocks WHERE shareId=?').get(row.id)!.n,
      1,
    );
    assert.equal(s.store.nextCleanup(), 3000);
    s.store.cleanup();
    assert.equal(s.store.get(row.id), undefined);
    assert.equal(s.store.authorize(permanent.id, 'keep').id, permanent.id);
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
      assert.throws(() =>
        s.store.publish(row.id, 'hash', '标题', tokenHash('token'), 'cipher', expiresAt),
      );
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
    assert.throws(() => s.store.publish(row.id, 'hash', '标题', tokenHash('token'), 'cipher'));
    for (let seq = 1; seq < 9; seq++)
      s.store.append(row.id, seq, {
        message: 0,
        role: 'user',
        channel: 'text',
        text: String(seq),
        omittedAttachments: 0,
      });
    s.store.publish(row.id, 'hash', '标题', tokenHash('token'), 'cipher');
    s.store.cleanup();
    const first = s.store.page(s.store.authorize(row.id, 'token'));
    assert.equal(first.blocks.length, 4);
    assert.equal(first.cursor, 4);
    assert.equal(s.store.page(s.store.authorize(row.id, 'token'), 8).cursor, null);
    assert.throws(() => s.store.page(row, 9));
    s.store.delete(row.id);
    assert.equal(s.store.get(row.id), undefined);
  } finally {
    s.db.close();
  }
});

test('full snapshots stream all ordered blocks as one JSON response and reject missing blocks', async () => {
  const s = fixture();
  try {
    const row = s.draft();
    for (let seq = 1; seq < 10; seq++)
      s.store.append(row.id, seq, {
        message: 0,
        role: 'assistant',
        channel: 'text',
        text: `🙂${seq}`.repeat(8000),
        omittedAttachments: 0,
      });
    s.store.finishDraft(row.id, 'v', 1, 10, 0, 'hash');
    const ready = s.store.publish(row.id, 'hash', '全文', tokenHash('token'), 'cipher');
    const response = snapshotResponse(publicShare(ready), s.store.payloads(ready));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = (await response.json()) as {
      page: { blocks: { text: string }[]; cursor: null };
    };
    assert.equal(result.page.blocks.length, 10);
    assert.equal(result.page.cursor, null);
    assert.equal(result.page.blocks[9].text, '🙂9'.repeat(8000));
    s.db.prepare('DELETE FROM share_blocks WHERE shareId=? AND seq=5').run(row.id);
    await assert.rejects(
      snapshotResponse(publicShare(ready), s.store.payloads(ready)).text(),
      /Incomplete/,
    );
  } finally {
    s.db.close();
  }
});

test('cancelling a full response stops reading blocks instead of buffering the full snapshot', async () => {
  let reads = 0,
    closed = false;
  const payloads = function* () {
    try {
      for (let i = 0; i < 10000; i++) {
        reads++;
        yield JSON.stringify({ text: String(i) });
      }
    } finally {
      closed = true;
    }
  };
  const response = snapshotResponse(
    {
      id: 'id',
      title: 'title',
      createdAt: 0,
      expiresAt: null,
      messageCount: 1,
      omittedAttachments: 0,
      hash: 'hash',
    },
    payloads(),
  );
  const reader = response.body!.getReader();
  await reader.read(); // JSON header.
  await reader.read(); // Only the first block is requested.
  await reader.cancel();
  assert.ok(reads < 3);
  assert.equal(closed, true);
});
