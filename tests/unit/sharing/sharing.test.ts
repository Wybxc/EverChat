import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../../shared/conversation/types';
import { messageParts } from '../../../shared/conversation/content';
import { projectShare } from '../../../shared/sharing/projection';
import { SHARING_SCHEMA } from '../../../worker/sharing/schema';
import { ShareRepository } from '../../../worker/sharing/store';
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
      includeReasoning: false,
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
test('share projection exposes only the selected completed branch and explicitly opted-in reasoning', () => {
  const a = message('a'),
    b = message('b', 'a'),
    c = message('other-branch', 'a');
  const summary = { ...message('summary', 'a'), summary: { sourceIds: ['a'] } } as Message;
  const projected = projectShare([a, b, c, summary], 'b', false);
  const blocks = [...projected.blocks()];
  assert.equal(projected.messageCount, 2);
  assert.deepEqual(
    blocks.map((b) => b.text),
    ['正文 a', '正文 b'],
  );
  assert.doesNotMatch(JSON.stringify(blocks), /private|other-branch|sourceIds|思考/);
  assert.ok([...projectShare([a, b], 'b', true).blocks()].some((b) => b.channel === 'reasoning'));
  assert.throws(() => projectShare([a, { ...b, status: 'running' }], 'b', false));
  assert.throws(() => projectShare([{ ...a, deletedAt: 10 }, b], 'b', false));
});
test('large public messages split below SQLite/RPC limits without corrupting surrogate pairs', () => {
  const text = '😀'.repeat(40_000),
    a = { ...message('a'), parts: messageParts(text) };
  const blocks = [...projectShare([a], 'a', false).blocks()];
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
test('drafts never authorize; publication is idempotent and every page rechecks revocation and token rotation', () => {
  const s = fixture();
  try {
    const row = s.draft();
    assert.throws(() => s.store.authorize(row.id, 'token'));
    s.store.publish(row.id, 'hash', '公开标题', 7, tokenHash('token'), 'cipher');
    assert.equal(s.store.authorize(row.id, 'token').title, '公开标题');
    s.store.publish(row.id, 'hash', 'changed-on-retry', 1, tokenHash('new'), 'newcipher');
    assert.equal(s.store.authorize(row.id, 'token').title, '公开标题');
    s.store.update(row.id, { rotate: { hash: tokenHash('new'), cipher: 'newcipher' } });
    assert.throws(() => s.store.authorize(row.id, 'token'));
    assert.equal(s.store.page(s.store.authorize(row.id, 'new')).blocks[0].text, 'hello');
    s.store.revoke(row.id);
    assert.throws(() => s.store.authorize(row.id, 'new'));
    assert.doesNotMatch(JSON.stringify(s.store.list()), /tokenHash|tokenCipher|cipher/);
  } finally {
    s.db.close();
  }
});
test('expiry is checked without cleanup or per-visit writes and deleted conversations cannot publish an in-flight preview', () => {
  const s = fixture();
  try {
    const row = s.draft();
    s.store.publish(row.id, 'hash', '标题', 1, tokenHash('token'), 'cipher');
    s.tick(1000 + 86_400_000);
    assert.equal(s.store.list().shares[0].status, 'expired');
    assert.throws(() => s.store.authorize(row.id, 'token'));
    assert.throws(() => s.store.update(row.id, { expiry: null }));
    const pending = s.draft('operation2');
    s.store.revokeConversation('conversation');
    assert.throws(() =>
      s.store.publish(pending.id, 'hash', '标题', null, tokenHash('token'), 'cipher'),
    );
    assert.throws(() =>
      s.store.begin({
        operationId: 'new',
        conversationId: 'conversation',
        headId: 'a',
        title: '标题',
        includeReasoning: false,
      }),
    );
    s.store.cleanup();
    assert.equal(s.store.page(s.store.get(row.id)!).blocks.length, 0);
  } finally {
    s.db.close();
  }
});
test('incomplete snapshots cannot publish; paging and cleanup preserve active immutable content', () => {
  const s = fixture();
  try {
    const row = s.draft();
    s.store.finishDraft(row.id, 'v', 1, 9, 0, 'hash');
    assert.throws(() =>
      s.store.publish(row.id, 'hash', '标题', null, tokenHash('token'), 'cipher'),
    );
    for (let seq = 1; seq < 9; seq++)
      s.store.append(row.id, seq, {
        message: 0,
        role: 'user',
        channel: 'text',
        text: String(seq),
        omittedAttachments: 0,
      });
    s.store.publish(row.id, 'hash', '标题', null, tokenHash('token'), 'cipher');
    s.store.cleanup();
    const first = s.store.page(s.store.authorize(row.id, 'token'));
    assert.equal(first.blocks.length, 4);
    assert.equal(first.cursor, 4);
    assert.equal(s.store.page(s.store.authorize(row.id, 'token'), 8).cursor, null);
    assert.throws(() => s.store.page(row, 9));
    assert.throws(() => s.store.purge(row.id));
    s.store.revoke(row.id);
    s.store.purge(row.id);
    assert.equal(s.store.get(row.id), undefined);
  } finally {
    s.db.close();
  }
});
