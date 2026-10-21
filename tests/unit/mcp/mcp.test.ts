import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as v from 'valibot';
import { conversationSettingsDefaults } from '../../../shared/conversation/settings';
import { messageParts } from '../../../shared/conversation/content';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { initializeConversation } from '../../../worker/conversation/schema';
import { ConversationMessages } from '../../../worker/conversation/messages';
import { GenerationCheckpoints } from '../../../worker/streaming/checkpoints';
import { chatSchema, decodeRef, encodeRef, McpError } from '../../../worker/mcp/contracts';
import { readMcpStatus } from '../../../worker/mcp/conversation';
import { McpKeys, MCP_KEYS_SCHEMA } from '../../../worker/mcp/keys';
import { MCP_REQUESTS_SCHEMA } from '../../../worker/mcp/schema';
import { McpRequests } from '../../../worker/mcp/store';
import type { Env } from '../../../worker/http/env';
import type { ProviderSettingsStore } from '../../../worker/providers/store';
import { defaultProviderSettings, runtimeProviderConfig } from '../../../worker/providers/config';
import { migrateStorage } from '../../../scripts/operations/migrations';
import { initializeStorageSchema } from '../../../worker/platform/storage-schema';

function database() {
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
  const storage = {
    sql: { exec: query },
    transactionSync: <T>(fn: () => T) => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, query, storage };
}
test('MCP API keys are hash-only, independently scoped and immediately revocable', () => {
  const { db, query } = database();
  try {
    query(MCP_KEYS_SCHEMA);
    const keys = new McpKeys(query),
      first = keys.create('script'),
      second = keys.create('client');
    assert.deepEqual(keys.authenticate(first.key), { keyId: first.id });
    assert.equal(
      keys.authenticate(first.key.slice(0, -1) + (first.key.endsWith('a') ? 'b' : 'a')),
      null,
    );
    assert.equal(JSON.stringify(keys.list()).includes(first.key), false);
    assert.equal(
      JSON.stringify(query('SELECT * FROM mcp_keys').toArray()).includes(first.key),
      false,
    );
    keys.revoke(first.id);
    keys.revoke(first.id);
    assert.equal(keys.authenticate(first.key), null);
    assert.deepEqual(keys.authenticate(second.key), { keyId: second.id });
  } finally {
    db.close();
  }
});
test('MCP key metadata supports rename and records successful use at most once per hour', (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const { db, query } = database();
  try {
    query(MCP_KEYS_SCHEMA);
    const keys = new McpKeys(query),
      issued = keys.create('first');
    assert.equal(issued.lastUsedAt, null);
    assert.equal(issued.keyHint, `ec_mcp_••••${issued.key.slice(-6)}`);
    const updated = keys.rename(issued.id, 'renamed');
    assert.equal(updated?.name, 'renamed');
    assert.equal(updated?.keyHint, issued.keyHint);
    assert.equal(updated?.createdAt, issued.createdAt);
    assert.equal(JSON.stringify(updated).includes(issued.key), false);
    assert.equal(keys.rename(crypto.randomUUID(), 'missing'), null);
    keys.authenticate(issued.key);
    const changes = query<{ count: number }>('SELECT total_changes() AS count').one().count;
    now += 1000;
    keys.authenticate(issued.key);
    assert.equal(query<{ count: number }>('SELECT total_changes() AS count').one().count, changes);
    assert.equal(keys.list()[0].lastUsedAt, 1_000_000);
    now += 60 * 60 * 1000;
    keys.authenticate(issued.key + 'bad');
    assert.equal(keys.list()[0].lastUsedAt, 1_000_000);
    keys.authenticate(issued.key);
    assert.equal(keys.list()[0].lastUsedAt, now);
    keys.revoke(issued.id);
    assert.equal(keys.rename(issued.id, 'revoked'), null);
  } finally {
    db.close();
  }
});
test('MCP idempotency freezes accepted configuration before mutable model lookup and does not duplicate conversations', () => {
  const { db, query, storage } = database();
  try {
    query(MCP_REQUESTS_SCHEMA);
    const env = {
      AI_PROVIDER: 'openai-chat',
      AI_BASE_URL: 'https://private.example/v1',
      AI_MODEL: 'test-model',
      AI_API_KEY: 'private-key',
      SYSTEM_PROMPT: 'default',
    } as Env;
    const settings = defaultProviderSettings(env),
      conversations = new Set<string>();
    const providers = {
      providerSettingsData: () => settings,
      providerConfig: (selection: Parameters<typeof runtimeProviderConfig>[1]) =>
        runtimeProviderConfig(settings, selection),
      titleConfig: () => null,
    } as unknown as ProviderSettingsStore;
    const store = new McpRequests(
      storage,
      providers,
      () => [],
      env,
      (id) => conversations.add(id),
      (id) => conversations.has(id),
      () => undefined,
    );
    const modelRef = store.catalog().models[0].ref;
    assert.equal(JSON.stringify(store.catalog()).includes('private'), false);
    const input = v.parse(chatSchema, {
      requestId: crypto.randomUUID(),
      modelRef,
      prompt: 'hello',
      waitMs: 0,
    });
    const first = store.prepare('one', input);
    settings.providers[0].models[0].enabled = false;
    settings.providers[0].apiKey = 'changed-key';
    assert.deepEqual(
      store.prepare('one', { ...input, waitMs: 10_000 }),
      JSON.parse(JSON.stringify(first)),
    );
    assert.equal(conversations.size, 1);
    assert.throws(
      () => store.prepare('one', { ...input, prompt: 'changed' }),
      (error) => error instanceof McpError && error.detail.code === 'IDEMPOTENCY_CONFLICT',
    );
    const accepted = store.finish('one', input.requestId, {
      runId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
    });
    assert.equal(accepted.prepared, undefined);
    assert.equal(
      JSON.stringify(query('SELECT * FROM mcp_requests').toArray()).includes('private-key'),
      false,
    );
    const continuation = encodeRef('continue1', [
      first.conversationId,
      first.requestId,
      accepted.submission!.assistantId,
    ]);
    assert.throws(
      () => store.prepare('two', { ...input, requestId: crypto.randomUUID(), continuation }),
      /unavailable/,
    );
    settings.providers[0].models[0].enabled = true;
    const continued = store.prepare(
      'one',
      v.parse(chatSchema, { requestId: crypto.randomUUID(), continuation, prompt: 'continue' }),
    );
    assert.equal(continued.conversationId, first.conversationId);
    assert.equal(continued.prepared!.input.parentId, accepted.submission!.assistantId);
    assert.equal(continued.prepared!.input.tools, undefined);
    const other = store.prepare('two', input);
    assert.notEqual(other.conversationId, first.conversationId);
  } finally {
    db.close();
  }
});
test('MCP pagination reads complete Unicode text and reasoning without splitting surrogate pairs; deleted messages are unavailable', () => {
  const { db, query, storage } = database();
  try {
    initializeConversation(storage.sql, false);
    const journal = new GenerationCheckpoints(query),
      messages = new ConversationMessages(
        query,
        journal,
        () => null,
        () => {},
      );
    const text = 'a'.repeat(8191) + '😀' + '正文'.repeat(15_000),
      reasoning = '思考🧠'.repeat(10_000);
    const message = {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      parts: messageParts(text, reasoning),
      status: 'completed' as const,
      runId: crypto.randomUUID(),
      createdAt: Date.now(),
      parentId: null,
      revisionOf: null,
      error: null,
    };
    messages.insert(message);
    journal.compact(message);
    for (const [channel, expected] of [
      ['content', text],
      ['reasoning', reasoning],
    ] as const) {
      let offset = 0,
        actual = '';
      for (;;) {
        const page = journal.page(message.id, channel, offset);
        assert.ok(page.text.length <= 8192);
        assert.equal(new TextDecoder().decode(new TextEncoder().encode(page.text)), page.text);
        actual += page.text;
        if (!page.hasMore) break;
        assert.ok(page.nextOffset > offset);
        offset = page.nextOffset;
      }
      assert.equal(actual, expected);
    }
    assert.equal(readMcpStatus(query, message.id)?.hasContent, true);
    query('INSERT INTO message_deletions VALUES (?,?)', message.id, Date.now());
    assert.equal(readMcpStatus(query, message.id), null);
  } finally {
    db.close();
  }
});
test('MCP references support Unicode IDs; tool input rejects excess bytes, unknown modes and non-finite wait', () => {
  const id = '供应商/模型😀';
  assert.deepEqual(decodeRef('model1', encodeRef('model1', [crypto.randomUUID(), id]), 2)[1], id);
  const base = { requestId: crypto.randomUUID(), prompt: 'hello' };
  for (const extra of [
    { waitMs: 20_001 },
    { waitMs: NaN },
    { persist: false },
    { jsonSchema: {} },
    { prompt: '字'.repeat(300_000) },
  ])
    assert.equal(v.safeParse(chatSchema, { ...base, ...extra }).success, false);
  assert.equal(conversationSettingsDefaults().useGlobalMaxOutputTokens, true);
});
test('MCP tables are introduced only by offline schema 2 to 3 migration', () => {
  const { db, query } = database();
  try {
    db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,2)',
    );
    assert.throws(() => initializeStorageSchema(query));
    assert.equal(query("SELECT name FROM sqlite_master WHERE name='mcp_keys'").toArray().length, 0);
    migrateStorage(db, 'library');
    initializeStorageSchema(query);
    assert.equal(query('SELECT * FROM mcp_keys').toArray().length, 0);
    assert.equal(query('SELECT * FROM mcp_requests').toArray().length, 0);
  } finally {
    db.close();
  }
});
