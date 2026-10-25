import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { discussionSource, McpDiscussion } from '../../../worker/mcp/discussion';
import { chatSchema, encodeRef, McpError } from '../../../worker/mcp/contracts';
import { initializeConversation } from '../../../worker/conversation/schema';
import type { SqlQuery } from '../../../worker/generation/metrics';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
test('discussion snapshots validate exact source versions and quotes, exclude assistant backgrounds and summaries', async () => {
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
  try {
    initializeConversation({ exec: query } as unknown as SqlStorage, false);
    const id = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      text = 'Background🙂 with an exact definition.';
    db.prepare(
      "INSERT INTO messages(id,role,content,status,createdAt,parentId) VALUES (?,'user',?,'completed',1,NULL)",
    ).run(id, text);
    db.prepare('INSERT OR REPLACE INTO message_versions VALUES (?,?)').run(id, 2);
    const citation = {
      messageRef: encodeRef('message1', [conversation, id]),
      revision: 2,
      sha256: hash(text),
    };
    assert.equal(discussionSource(query, id, citation, false).text, text);
    const range = { start: 0, end: 12 },
      quote = text.slice(0, 12);
    assert.equal(
      discussionSource(query, id, { ...citation, range, quoteHash: hash(quote) }, false).text,
      quote,
    );
    for (const invalid of [
      { ...citation, revision: 1 },
      { ...citation, sha256: hash('changed') },
      { ...citation, range, quoteHash: hash('wrong') },
    ])
      assert.throws(() => discussionSource(query, id, invalid, false), McpError);
    assert.throws(() => discussionSource(query, id, citation, true), /completed answers/);
    const helper = new McpDiscussion(
      () => true,
      async (_, id, c, target) => discussionSource(query, id, c, target),
      async () => ({ text: 'file', metadata: {} }),
    );
    const args = v.parse(chatSchema, {
      requestId: crypto.randomUUID(),
      prompt: 'Independent',
      discussion: { mode: 'independent', background: [citation] },
    });
    const saved = await helper.prepare(args);
    assert(saved?.includes(text));
    assert(saved?.includes('explicit_whitelist'));
    assert(!v.safeParse(chatSchema, { ...args, continuation: 'not-allowed' }).success);
    assert(!v.safeParse(chatSchema, { ...args, discussion: { mode: 'review' } }).success);
    const denied = new McpDiscussion(
      () => false,
      async () => {
        throw new Error('must not read');
      },
      async () => ({ text: '', metadata: {} }),
    );
    await assert.rejects(() => denied.prepare(args), /not authorized/);
  } finally {
    db.close();
  }
});
