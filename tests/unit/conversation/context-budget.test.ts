import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { backupMessage } from '../../../shared/backup/backup';
import { messageParts } from '../../../shared/conversation/content';
import {
  assertContextFits,
  assertStoredContextFits,
  buildContext,
  contextHistory,
  contextEstimateSchema,
  contextSource,
  estimateTextTokens,
  TOKEN_SAMPLE_UNITS,
} from '../../../shared/conversation/context-budget';
import {
  conversationSettingsSchema,
  DEFAULT_CONVERSATION_SETTINGS as defaults,
} from '../../../shared/conversation/settings';
import type { Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import { chatModels } from '../../../shared/models/selection';
import type { ModelMetadataOverrides } from '../../../shared/models/types';
import type { ChatInput, ProviderSettingsInput } from '../../../shared/providers/types';
import { generationSchema } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';

const config = { systemPrompt: '', maxOutputTokens: null };
const metadata = (overrides: ModelMetadataOverrides) =>
  resolveModelMetadata('openai-chat', {
    id: 'unknown',
    name: '',
    enabled: true,
    metadataOverrides: overrides,
  });
const history: ChatInput[] = [
  { role: 'user', content: '旧问题'.repeat(20) },
  { role: 'assistant', content: '旧回答'.repeat(20) },
  { role: 'user', content: '新问题'.repeat(20) },
  { role: 'assistant', content: '新回答'.repeat(20) },
];

test('context selection retains source identities and the actual reason each complete history turn was omitted', () => {
  const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    parts: messageParts(`message ${index}`),
    status: 'completed',
    parentId: index ? `message-${index - 1}` : null,
    runId: null,
    createdAt: index,
    revisionOf: null,
    error: null,
  }));
  const prepared = contextHistory(messages, 'message-5');
  const current = { kind: 'message' as const, messageId: 'new-question' };
  const limited = buildContext(
    prepared,
    'new question',
    config,
    { ...defaults, recentMessages: 2 },
    undefined,
    [],
    [],
    current,
  );
  assert.deepEqual(
    limited.messages.map(({ source }) => source?.messageId),
    ['message-4', 'message-5', 'new-question'],
  );
  assert.deepEqual(
    limited.selection.omitted.map(({ input, reason }) => [input.source?.messageId, reason]),
    ['message-0', 'message-1', 'message-2', 'message-3'].map((id) => [id, 'recent_messages']),
  );
  const budget = buildContext(prepared.slice(-2), 'new question', config, defaults).estimate
    .totalTokens;
  const budgeted = buildContext(prepared, 'new question', config, {
    ...defaults,
    contextBudget: budget,
  });
  assert.equal(budgeted.estimate.retainedMessages, 2);
  assert.equal(
    budgeted.selection.omitted.every(({ reason }) => reason === 'context_budget'),
    true,
  );
  const summarized = buildContext(prepared.slice(2), 'new question', config, defaults, {
    id: 'summary',
    content: 'Summary of the first turn',
    coveredMessages: 2,
    sourceIds: ['message-0', 'message-1'],
  });
  assert.deepEqual(summarized.messages[0].source, { kind: 'summary', messageId: 'summary' });
  assert.deepEqual(summarized.selection.summarized, ['message-0', 'message-1']);
  assert.equal(summarized.selection.omitted.length, 0);
  assert.equal(summarized.estimate.totalTokens > summarized.estimate.inputTokens, true);
  const excluded = contextHistory(
    [{ ...messages[0], deletedAt: 10 }, ...messages.slice(1)],
    'message-5',
  );
  assert.deepEqual(
    excluded.map(({ source }) => source?.messageId),
    ['message-2', 'message-3', 'message-4', 'message-5'],
  );
});

test('large model windows cannot create a context/config row beyond the SQLite task budget', () => {
  const large = 'x'.repeat(768_000);
  const model = { ...config, modelMetadata: metadata({ contextWindow: 10_000_000 }) };
  const built = buildContext(
    [
      { role: 'user', content: large },
      { role: 'assistant', content: large },
    ],
    'next',
    model,
    defaults,
  );
  assert.doesNotThrow(() => assertStoredContextFits(built.messages, model));
  assert.throws(
    () =>
      assertStoredContextFits(built.messages, { ...model, systemPrompt: '\u0000'.repeat(64_000) }),
    /单次任务.*存储保护/,
  );
});

test('text estimates account for Unicode, punctuation and empty input with bounded work on long content', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.ok(estimateTextTokens('中文测试') > estimateTextTokens('test'));
  assert.ok(estimateTextTokens('🙂') > 0);
  assert.ok(estimateTextTokens('{}[]') >= estimateTextTokens('word'));
  let reads = 0;
  const text = {
    length: 100_000_000,
    charCodeAt: () => {
      reads++;
      return 65;
    },
  } as unknown as string;
  const count = estimateTextTokens(text);
  assert.ok(count > 30_000_000);
  assert.ok(reads <= TOKEN_SAMPLE_UNITS);
  // A multilingual tail is included in the distributed sample, unlike a prefix-only shortcut.
  assert.ok(
    estimateTextTokens('a'.repeat(50000) + '中'.repeat(50000)) >
      estimateTextTokens('a'.repeat(100000)),
  );
});

test('unknown models use a labelled fallback and unknown windows do not truncate history or invent output reserves', () => {
  const { estimate } = buildContext([], 'hello', config, defaults);
  assert.equal(estimate.method, 'approximate-v1');
  assert.equal(estimate.windowSource, 'fallback');
  assert.equal(estimate.contextWindow, 32768);
  assert.equal(estimate.outputReserve, 0);
  assert.equal(estimate.inputBudget, Number.MAX_SAFE_INTEGER);
  assert.equal(config.maxOutputTokens, null);
  assert.doesNotThrow(() => assertContextFits(estimate));
  const largeHistory: ChatInput[] = [
    { role: 'user', content: '历史'.repeat(50_000) },
    { role: 'assistant', content: '保留'.repeat(50_000) },
  ];
  assert.equal(buildContext(largeHistory, 'next', config, defaults).estimate.omittedMessages, 0);
  assert.equal(
    buildContext(largeHistory, 'next', config, { ...defaults, contextBudget: 100 }).estimate
      .omittedMessages,
    2,
  );
});

test('shared windows reserve explicit output limits; separate input windows do not subtract output twice', () => {
  const combined = {
    ...config,
    maxOutputTokens: 1000,
    modelMetadata: metadata({ contextWindow: 10000, maxOutputTokens: 2000 }),
  };
  assert.equal(buildContext([], 'x', combined, defaults).estimate.inputBudget, 9000);
  const separate = {
    ...combined,
    modelMetadata: metadata({ contextWindow: 10000, maxOutputTokens: 2000, contextScope: 'input' }),
  };
  assert.equal(buildContext([], 'x', separate, defaults).estimate.inputBudget, 10000);
  assert.equal(buildContext([], 'x', separate, defaults).estimate.outputReserve, 1000);
  assert.equal(
    buildContext([], 'x', combined, { ...defaults, contextBudget: 50000 }).estimate.inputBudget,
    9000,
  );
  assert.equal(
    buildContext([], 'x', combined, { ...defaults, contextBudget: 500 }).estimate.inputBudget,
    500,
  );
});

test('budgeting retains complete recent turns, preserves original text and exposes omitted history', () => {
  const before = structuredClone(history);
  const built = buildContext(history, 'next', config, { ...defaults, contextBudget: 300 });
  assert.deepEqual(built.messages.slice(0, -1), history.slice(2));
  assert.equal(built.estimate.retainedMessages, 2);
  assert.equal(built.estimate.omittedMessages, 2);
  assert.ok(built.estimate.totalTokens <= built.estimate.inputBudget);
  assert.equal(built.messages.at(-1)?.content, 'next');
  assert.deepEqual(history, before);
  assert.deepEqual(
    buildContext(history, 'next', config, { ...defaults, recentMessages: 3 }).messages.slice(0, -1),
    history.slice(2),
  );
  assert.equal(
    buildContext(history, 'next', config, { ...defaults, recentMessages: 1 }).estimate
      .retainedMessages,
    0,
  );
});

test('an oversized most recent turn drops the older prefix too; no orphaned answer or clipped message is sent', () => {
  const built = buildContext(
    [
      ...history.slice(0, 2),
      { role: 'user', content: '大'.repeat(500) },
      { role: 'assistant', content: '完整' },
    ],
    'x',
    config,
    { ...defaults, contextBudget: 300 },
  );
  assert.deepEqual(built.messages, [{ role: 'user', content: 'x' }]);
  assert.equal(built.estimate.omittedMessages, 4);
  const orphan = buildContext(
    [{ role: 'assistant', content: 'orphan' }, ...history.slice(2)],
    'x',
    config,
    defaults,
  );
  assert.equal(orphan.messages[0].role, 'user');
  assert.equal(orphan.estimate.omittedMessages, 1);
});

test('editing cached history changes its estimate instead of reusing the previous text count', () => {
  const mutable = structuredClone(history);
  assert.equal(
    buildContext(mutable, 'x', config, { ...defaults, contextBudget: 300 }).estimate
      .retainedMessages,
    2,
  );
  mutable[3].content = '大'.repeat(1000);
  assert.equal(
    buildContext(mutable, 'x', config, { ...defaults, contextBudget: 300 }).estimate
      .retainedMessages,
    0,
  );
});

test('system prompts and framing are charged and oversized fixed input fails instead of being truncated', () => {
  const built = buildContext(
    history,
    '当前输入'.repeat(20),
    { ...config, systemPrompt: '系统'.repeat(20) },
    { ...defaults, contextBudget: 100 },
  );
  assert.equal(built.estimate.systemTokens, estimateTextTokens('系统'.repeat(20)) + 8);
  assert.ok(built.estimate.totalTokens > built.estimate.inputTokens + built.estimate.systemTokens);
  assert.throws(() => assertContextFits(built.estimate), /超过上下文预算/);
  assert.equal(built.messages[0].content, '当前输入'.repeat(20));
});

test('preview sources match normal continuation, user-ending copies, revision and regeneration paths', () => {
  const user: Message = {
    id: 'u',
    role: 'user',
    parts: messageParts('root'),
    status: 'completed',
    createdAt: 1,
    runId: null,
    parentId: null,
    revisionOf: null,
    error: null,
  };
  const answer: Message = {
    ...user,
    id: 'a',
    role: 'assistant',
    parentId: 'u',
    parts: messageParts('answer'),
  };
  const tail: Message = {
    ...user,
    id: 'tail',
    parentId: 'a',
    parts: messageParts('trailing question'),
  };
  assert.deepEqual(contextSource([user, answer, tail], { content: 'next', parentId: 'tail' }), {
    content: 'next',
    parentId: 'tail',
  });
  assert.deepEqual(contextSource([user, answer, tail], { content: ' next ', parentId: 'a' }), {
    content: 'next',
    parentId: 'a',
  });
  assert.deepEqual(contextSource([user, answer, tail], { content: 'edit', revisionOf: 'u' }), {
    content: 'edit',
    parentId: null,
  });
  assert.deepEqual(contextSource([user, answer, tail], { retryOf: 'a' }), {
    content: 'root',
    parentId: null,
  });
});

test('settings and stored estimates reject invalid bounds and unexpected private fields', () => {
  assert.equal(
    v.safeParse(conversationSettingsSchema, { ...defaults, systemPrompt: '中'.repeat(640_000) })
      .success,
    false,
  );
  assert.equal(
    v.safeParse(conversationSettingsSchema, {
      ...defaults,
      systemPrompt: 'x'.repeat(100_000),
      recentMessages: 10_000,
      contextBudget: 10_000_000,
    }).success,
    true,
  );
  for (const patch of [
    { contextBudget: 0 },
    { contextBudget: 1.5 },
    { contextBudget: Infinity },
    { recentMessages: 0 },
    { recentMessages: 1.5 },
  ]) {
    assert.equal(v.safeParse(conversationSettingsSchema, { ...defaults, ...patch }).success, false);
  }
  const context = buildContext([], 'x', config, defaults).estimate;
  assert.deepEqual(v.parse(contextEstimateSchema, context), context);
  for (const patch of [
    { inputTokens: -1 },
    { contextWindow: Infinity },
    { method: 'exact' },
    { apiKey: 'private' },
  ])
    assert.equal(v.safeParse(contextEstimateSchema, { ...context, ...patch }).success, false);
  assert.equal(
    v.safeParse(generationSchema, { usage: {}, usageIsFinal: false, context }).success,
    true,
  );
});

test('partial backups preserve accepted estimates alongside the latest durable supplier usage', () => {
  const context = buildContext([], 'x', config, defaults).estimate;
  const message: Message = {
    id: 'a',
    role: 'assistant',
    parts: [],
    status: 'running',
    createdAt: 1,
    runId: 'run',
    parentId: 'u',
    revisionOf: null,
    error: null,
    generation: { usage: {}, usageIsFinal: false, context },
    streamState: {
      ...new ProviderStream('openai-chat', false).checkpoint(),
      usage: { inputTokens: 12 },
    },
  };
  assert.deepEqual(backupMessage(message).generation, {
    usage: { inputTokens: 12 },
    usageIsFinal: false,
    context,
  });
});

test('public chat models expose effective overrides for local estimation without including API keys', () => {
  const settings: ProviderSettingsInput = {
    providers: [
      {
        id: 'p',
        name: 'Provider',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test',
        apiKey: 'private-key',
        models: [
          { id: 'global', name: '', enabled: true },
          { id: 'empty', name: '', enabled: true, useGlobalSystemPrompt: false, systemPrompt: '' },
          {
            id: 'custom',
            name: '',
            enabled: true,
            useGlobalSystemPrompt: false,
            systemPrompt: 'custom prompt',
          },
        ],
      },
    ],
    activeProviderId: 'p',
    activeModel: 'global',
    systemPrompt: 'global prompt',
    maxOutputTokens: null,
  };
  const models = chatModels(settings);
  assert.equal(models[0].systemPrompt, undefined);
  assert.equal(models[1].systemPrompt, '');
  assert.equal(models[2].systemPrompt, 'custom prompt');
  assert.ok(!JSON.stringify(models).includes('private-key'));
});
