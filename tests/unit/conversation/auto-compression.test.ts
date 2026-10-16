import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { messageParts } from '../../../shared/conversation/content';
import {
  historyCountWithinLimit,
  measureContextDemand,
} from '../../../shared/conversation/context-budget';
import {
  conversationSettingsSchema,
  DEFAULT_CONVERSATION_SETTINGS as defaults,
} from '../../../shared/conversation/settings';
import { prepareChatContext, summaryGeneration } from '../../../shared/conversation/summaries';
import type { Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig } from '../../../shared/providers/types';

const config: ProviderConfig = {
  provider: 'openai-chat',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'unused',
  model: 'fixture',
  systemPrompt: '',
  maxOutputTokens: null,
  modelMetadata: resolveModelMetadata('openai-chat', {
    id: 'fixture',
    name: '',
    enabled: true,
    metadataOverrides: { contextWindow: 4096, maxOutputTokens: 1024 },
  }),
};
const settings = {
  ...defaults,
  contextBudget: 500,
  autoCompression: { enabled: true, threshold: 80, model: null },
};
function history() {
  let parentId: string | null = null;
  return [
    '重要事实'.repeat(250),
    '记住预算 42 元',
    '最近提问',
    '最近回答',
    '后续提问',
    '后续回答',
  ].map((text, index): Message => {
    const message: Message = {
      id: crypto.randomUUID(),
      role: index % 2 ? 'assistant' : 'user',
      parts: messageParts(text),
      status: 'completed',
      createdAt: index + 1,
      runId: null,
      parentId,
      revisionOf: null,
      error: null,
    };
    parentId = message.id;
    return message;
  });
}
test('automatic compression is off by default and plans from full history before the raw-tail count limit', () => {
  const messages = history(),
    head = messages.at(-1)!.id;
  const disabled = prepareChatContext(messages, head, 'next', config, {
    ...settings,
    autoCompression: defaults.autoCompression,
  });
  assert.equal(disabled.automatic, undefined);
  assert.equal(disabled.estimate.omittedMessages, 2);
  const automatic = prepareChatContext(messages, head, 'next', config, {
    ...settings,
    recentMessages: 2,
  });
  assert.equal(automatic.automatic?.throughId, messages[3].id);
  assert.equal(automatic.automatic?.demand.retainedMessages, 6);
  assert.ok(automatic.automatic!.demand.totalTokens > automatic.estimate.totalTokens);
  const below = prepareChatContext(
    messages.slice(2).map((message, index) => (index ? message : { ...message, parentId: null })),
    head,
    'next',
    config,
    settings,
  );
  assert.equal(below.automatic, undefined);
});
test('automatic coverage advances on the selected branch and never recompresses an identical boundary', () => {
  const path = history(),
    covered = path.slice(0, 4);
  const saved: Message = {
    ...path[3],
    id: crypto.randomUUID(),
    parts: messageParts('预算 42 元。'.repeat(35)),
    createdAt: 100,
    summary: { throughId: path[3].id, sourceIds: covered.map(({ id }) => id), automatic: true },
  };
  const messages = [...path, saved];
  assert.equal(
    prepareChatContext(messages, path.at(-1)!.id, 'next', config, settings).automatic?.throughId,
    path[5].id,
  );
  const same = prepareChatContext(messages, path[3].id, 'next', config, settings);
  assert.equal(same.automatic, undefined);
  const other = {
    ...path[0],
    id: crypto.randomUUID(),
    parts: messageParts('another branch'),
    parentId: null,
  };
  const answer = { ...path[1], id: crypto.randomUUID(), parentId: other.id };
  const branch = prepareChatContext(
    [...messages, other, answer],
    answer.id,
    'next',
    config,
    settings,
  );
  assert.equal(branch.automatic, undefined);
  assert.equal(branch.estimate.summaryId, undefined);
});
test('fixed input cannot be compressed, and selected summary model must fit the complete prefix', () => {
  const messages = history();
  assert.throws(
    () => prepareChatContext(messages, messages.at(-1)!.id, '输入'.repeat(150), config, settings),
    /超过上下文预算/,
  );
  const prepared = prepareChatContext(messages, messages.at(-1)!.id, 'next', config, settings);
  assert.throws(
    () =>
      summaryGeneration(messages, prepared.automatic!.throughId, {
        ...config,
        modelMetadata: { ...config.modelMetadata!, contextWindow: 1024 },
      }),
    /完整历史超出摘要模型窗口/,
  );
});
test('demand includes summary framing, independent input/output windows and the budget override', () => {
  const metadata = { ...config.modelMetadata!, contextScope: 'input' as const };
  const demand = measureContextDemand(
    [
      { role: 'user', content: 'history' },
      { role: 'assistant', content: 'answer' },
    ],
    'next',
    { ...config, systemPrompt: 'system', modelMetadata: metadata },
    { recentMessages: 1, contextBudget: 777 },
    { id: crypto.randomUUID(), content: 'summary and framing', coveredMessages: 2 },
  );
  assert.equal(demand.inputBudget, 777);
  assert.equal(demand.outputReserve, 1024);
  assert.ok(demand.summaryTokens! > 0);
  assert.ok(demand.systemTokens > 0);
  assert.equal(demand.retainedMessages, 2);
  assert.equal(
    demand.totalTokens,
    demand.inputTokens + demand.systemTokens + demand.historyTokens + demand.summaryTokens! + 11,
  );
});
test('raw-tail message counts preserve complete user-led turns without relying on fabricated model windows', () => {
  const history = [
    { role: 'assistant' as const, content: 'orphan' },
    { role: 'user' as const, content: 'one' },
    { role: 'assistant' as const, content: 'answer' },
    { role: 'user' as const, content: 'two' },
    { role: 'assistant' as const, content: 'answer' },
  ];
  assert.equal(historyCountWithinLimit(history, null), 4);
  assert.equal(historyCountWithinLimit(history, 3), 2);
  assert.equal(historyCountWithinLimit(history, 1), 0);
  assert.equal(historyCountWithinLimit([], null), 0);
});
test('automatic settings validate thresholds, model identity and the summary dependency', () => {
  assert.equal(v.safeParse(conversationSettingsSchema, settings).success, true);
  for (const threshold of [49, 96, 80.5, Number.NaN]) {
    assert.equal(
      v.safeParse(conversationSettingsSchema, {
        ...settings,
        autoCompression: { ...settings.autoCompression, threshold },
      }).success,
      false,
    );
  }
  assert.equal(
    v.safeParse(conversationSettingsSchema, { ...settings, useSummaries: false }).success,
    false,
  );
  assert.equal(
    v.safeParse(conversationSettingsSchema, {
      ...settings,
      autoCompression: {
        ...settings.autoCompression,
        model: { providerId: 'invalid', model: 'x' },
      },
    }).success,
    false,
  );
});
