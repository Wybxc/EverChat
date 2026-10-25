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
import {
  chatSchema,
  decodeRef,
  encodeRef,
  McpError,
  runSchema,
} from '../../../worker/mcp/contracts';
import { readCompletion } from '../../../worker/mcp/completion';
import { McpChatService } from '../../../worker/mcp/service';
import { GenerationProgressStore } from '../../../worker/generation/progress';
import type { McpRecord } from '../../../worker/mcp/store';
import { readMcpStatus } from '../../../worker/mcp/conversation';
import { McpKeys, MCP_KEYS_SCHEMA } from '../../../worker/mcp/keys';
import { MCP_REQUESTS_SCHEMA } from '../../../worker/mcp/schema';
import { MCP_GRANTS_SCHEMA } from '../../../worker/mcp/history';
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
    query(MCP_GRANTS_SCHEMA);
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
        assert.ok(!('error' in page));
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
test('MCP output cursors are bounded by persisted UTF-16 content, not an arbitrary cumulative limit', () => {
  const { db, query, storage } = database();
  try {
    initializeConversation(storage.sql, false);
    const journal = new GenerationCheckpoints(query);
    const id = crypto.randomUUID();
    query(
      'INSERT INTO messages(id,role,content,reasoning,status,createdAt) VALUES(?,?,?,?,?,?)',
      id,
      'assistant',
      'a'.repeat(8191) + '😀tail',
      '',
      'running',
      Date.now(),
    );
    assert.deepEqual(journal.page(id, 'content', 8192), { error: 'invalid_cursor' });
    assert.deepEqual(journal.page(id, 'content', 100_000), { error: 'invalid_cursor' });
    assert.deepEqual(journal.page(id, 'content', -1), { error: 'invalid_cursor' });
    const text = '文'.repeat(800_000) + '😀';
    journal.compact({
      id,
      role: 'assistant',
      parts: messageParts(text),
      status: 'completed',
      runId: crypto.randomUUID(),
      createdAt: Date.now(),
      parentId: null,
      revisionOf: null,
      error: null,
    });
    assert.deepEqual(journal.page(id, 'content', 800_000), {
      text: '😀',
      hasMore: false,
      nextOffset: 800_002,
    });
    assert.deepEqual(journal.page(id, 'content', 800_001), { error: 'invalid_cursor' });
    assert.deepEqual(journal.page(id, 'content', 800_002), {
      text: '',
      hasMore: false,
      nextOffset: 800_002,
    });
    assert.deepEqual(journal.page(id, 'content', 800_003), { error: 'invalid_cursor' });
  } finally {
    db.close();
  }
});
test('MCP returns persisted running output and a reusable tail cursor without triggering model work', async () => {
  const { db, query, storage } = database();
  try {
    initializeConversation(storage.sql, false);
    const journal = new GenerationCheckpoints(query);
    const assistantId = crypto.randomUUID();
    query(
      'INSERT INTO messages(id,role,content,reasoning,status,createdAt) VALUES(?,?,?,?,?,?)',
      assistantId,
      'assistant',
      'saved prefix',
      'thinking',
      'running',
      Date.now(),
    );
    const progress = new GenerationProgressStore(query);
    progress.begin(assistantId, Date.now());
    progress.phase(assistantId, 'waiting_provider', true);
    progress.content(assistantId, {
      content: { length: 'saved prefix'.length, replaced: false },
      reasoning: { length: 'thinking'.length, replaced: false },
    });
    const record: McpRecord = {
      conversationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      model: { ref: 'model', id: 'test', name: 'Test', providerName: 'Fixture' },
      settings: conversationSettingsDefaults(),
      submission: { runId: crypto.randomUUID(), userId: crypto.randomUUID(), assistantId },
    };
    const env = {
      APP_ORIGIN: 'https://example.test',
      LIBRARY: {
        getByName: () => ({
          mcpRequest: (principal: string) => (principal === 'owner' ? record : undefined),
        }),
      },
      CONVERSATIONS: {
        getByName: () => ({
          mcpStatus: (id: string) => readMcpStatus(query, id),
          mcpPage: (
            id: string,
            channel: 'content' | 'reasoning',
            offset: number,
            expectedEpoch?: number,
          ) => {
            const progress = new GenerationProgressStore(query).get(id);
            const epoch = progress?.[channel].epoch ?? 0;
            if (expectedEpoch !== undefined && expectedEpoch !== epoch)
              return { error: 'output_changed' };
            return {
              ...journal.page(id, channel, offset),
              epoch,
              persistedAt: progress?.persistedAt ?? null,
              revision: progress?.revision ?? null,
            };
          },
        }),
      },
    } as unknown as Env;
    const service = new McpChatService(env, { keyId: 'owner' });
    const runRef = encodeRef('run1', [record.conversationId, record.requestId]);
    const first = await service.get({ runRef, waitMs: 0, includeReasoning: true });
    assert.equal(v.safeParse(runSchema, first).success, true);
    assert.equal(first.output.text, 'saved prefix');
    assert.equal(first.reasoning?.text, 'thinking');
    assert.equal(first.output.hasMore, false);
    assert.equal(first.output.contentFinal, false);
    assert.equal(first.completion, null);
    assert.equal(first.progress?.phase, 'generating');
    assert.equal(first.progress?.content.length, 'saved prefix'.length);
    const cursor = first.output.resumeCursor!;
    const input = { runRef, outputCursor: cursor, waitMs: 0, includeReasoning: false };
    assert.equal((await service.get(input)).output.text, '');
    query('UPDATE messages SET content=content || ? WHERE id=?', ' suffix', assistantId);
    assert.equal((await service.get(input)).output.text, ' suffix');
    query('UPDATE messages SET status=? WHERE id=?', 'completed', assistantId);
    query(
      'INSERT INTO message_generations VALUES(?,?)',
      assistantId,
      JSON.stringify({
        usage: {},
        usageIsFinal: false,
        finishReason: 'length',
        rawFinishReason: 'MAX_TOKENS',
      }),
    );
    const ended = await service.get(input);
    assert.equal(ended.output.contentFinal, true);
    assert.equal(ended.output.text, ' suffix');
    assert.equal(ended.completion?.truncated, true);
    assert.ok(ended.continuation);
    await assert.rejects(
      () => service.get({ ...input, outputCursor: first.reasoning!.resumeCursor! }),
      /cursor/,
    );
    const forged = encodeRef('page2', [record.requestId, assistantId, 'content', '0', '9999999']);
    await assert.rejects(() => service.get({ ...input, outputCursor: forged }), /cursor/);
    await assert.rejects(
      () => new McpChatService(env, { keyId: 'other' }).get(input),
      /unavailable/,
    );
    progress.content(assistantId, {
      content: { length: 'saved prefix suffix'.length, replaced: true },
      reasoning: { length: 'thinking'.length, replaced: false },
    });
    await assert.rejects(
      () => service.get(input),
      (error) => error instanceof McpError && error.detail.code === 'OUTPUT_CHANGED',
    );
    assert.equal(
      (await service.get({ runRef, waitMs: 0, includeReasoning: false })).output.text,
      'saved prefix suffix',
    );
  } finally {
    db.close();
  }
});
test('MCP distinguishes terminal completeness, length limits, interruption and unknown finish codes', () => {
  assert.equal(readCompletion('running', { finishReason: 'length' }), null);
  assert.deepEqual(
    readCompletion('completed', { finishReason: 'length', rawFinishReason: 'MAX_TOKENS' }),
    {
      state: 'incomplete',
      truncated: true,
      reason: 'provider_length_limit',
      rawFinishReason: 'MAX_TOKENS',
      requiresNewGeneration: true,
    },
  );
  assert.equal(readCompletion('completed', { finishReason: 'stop' })?.truncated, false);
  for (const status of ['interrupted', 'failed', 'cancelled'] as const) {
    assert.equal(readCompletion(status, { finishReason: 'error' })?.state, 'incomplete');
    assert.equal(readCompletion(status, { finishReason: 'error' })?.truncated, null);
  }
  assert.equal(readCompletion('completed')?.state, 'unknown');
  assert.equal(
    readCompletion('completed', { finishReason: 'content-filter' })?.requiresNewGeneration,
    true,
  );
  assert.equal(
    readCompletion('failed', { rawFinishReason: 'arbitrary private message' })?.rawFinishReason,
    null,
  );
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
    { prompt: '字'.repeat(1_000_000) },
  ])
    assert.equal(v.safeParse(chatSchema, { ...base, ...extra }).success, false);
  assert.equal(conversationSettingsDefaults().useGlobalMaxOutputTokens, true);
});
test('MCP tables are introduced only by offline migration from an earlier schema', async () => {
  const { db, query } = database();
  try {
    db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,2)',
    );
    assert.throws(() => initializeStorageSchema(query));
    assert.equal(query("SELECT name FROM sqlite_master WHERE name='mcp_keys'").toArray().length, 0);
    await migrateStorage(db, 'library');
    initializeStorageSchema(query);
    assert.equal(query('SELECT * FROM mcp_keys').toArray().length, 0);
    assert.equal(query('SELECT * FROM mcp_requests').toArray().length, 0);
  } finally {
    db.close();
  }
});
test('schema 3 progress storage is added only offline, without fabricated historical receipts', async () => {
  const { db, query, storage } = database();
  try {
    initializeConversation(storage.sql, false);
    query('DROP TABLE generation_progress');
    query('UPDATE storage_schema SET version=3');
    assert.throws(() => initializeConversation(storage.sql, false));
    assert.equal(
      query("SELECT 1 FROM sqlite_master WHERE name='generation_progress'").toArray().length,
      0,
    );
    const patch = await migrateStorage(db, 'conversation');
    initializeConversation(storage.sql, false);
    assert.equal(query('SELECT * FROM generation_progress').toArray().length, 0);
    assert.ok(patch.some(({ sql }) => sql.includes('generation_progress')));
  } finally {
    db.close();
  }
});
