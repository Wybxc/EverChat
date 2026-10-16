import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { summaryContext, summaryCoverageSchema, summaryForPath, summaryGeneration, summaryPrefix, MAX_SUMMARIES, MAX_SUMMARY_CHARACTERS, SUMMARY_SYSTEM_PROMPT } from '../shared/conversation/summaries';
import { assertContextFits, buildContext, contextSource } from '../shared/conversation/context-budget';
import { branchPath } from '../shared/conversation/branch-path';
import { type Message } from '../shared/conversation/types';
import { type ProviderConfig } from '../shared/providers/types';
import { messageParts, messageText } from '../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS as defaults } from '../shared/conversation/settings';
import { resolveModelMetadata } from '../shared/models/metadata';
import { BACKUP_FORMAT, BACKUP_VERSION, backupMessage, validateBackup } from '../shared/backup/backup';

function history() {
  let parentId: string | null = null;
  return ['重要事实：预算 42 元。', '确认预算。', '最近的问题', '最近的回答', '后续问题', '后续回答'].map((text, index): Message => {
    const message: Message = { id: crypto.randomUUID(), role: index % 2 ? 'assistant' : 'user', parts: messageParts(text), status: 'completed', createdAt: index,
      runId: null, parentId, revisionOf: null, error: null };
    parentId = message.id; return message;
  });
}
function summary(path: Message[], createdAt = 10): Message {
  return { ...path.at(-1)!, id: crypto.randomUUID(), role: 'assistant', parts: messageParts('预算 **42 元**。'), createdAt, parentId: path.at(-1)!.id,
    summary: { throughId: path.at(-1)!.id, sourceIds: path.map(({ id }) => id) } };
}
const config: ProviderConfig = { provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'unused', model: 'unknown', systemPrompt: 'custom', maxOutputTokens: null };
const metadata = (window: number) => resolveModelMetadata('openai-chat', { id: 'unknown', name: '', enabled: true, metadataOverrides: { contextWindow: window, maxOutputTokens: 4096 } });

test('summaries use exact parent paths, prefer the furthest coverage and then its newest replacement', () => {
  const path = history(), early = summary(path.slice(0, 2)), wide = summary(path.slice(0, 4), 11), replacement = summary(path.slice(0, 4), 12);
  const branch: Message[] = [{ ...path[0], id: crypto.randomUUID(), parts: messageParts('另一个分支') }, { ...path[1], id: crypto.randomUUID() }];
  branch[1].parentId = branch[0].id;
  const other = summary(branch, 100);
  const messages = [...path, early, wide, replacement, ...branch, other];
  assert.equal(summaryForPath(messages, path)?.id, replacement.id);
  assert.equal(summaryForPath(messages, path.slice(0, 2))?.id, early.id);
  assert.equal(summaryForPath(messages, branch)?.id, other.id);
  assert.equal(summaryForPath(messages, path.slice(0, 2), true), undefined);
  assert.equal(contextSource(messages.filter((message) => !branch.includes(message)), { content: 'next', parentId: path.at(-1)!.id }).parentId, path.at(-1)!.id);
});

test('queued, partial, failed, cancelled, deleted, empty and truncated summaries never replace original history', () => {
  const path = history(), candidate = summary(path.slice(0, 2));
  const variants: Message[] = ['queued', 'running', 'failed', 'cancelled'].map((status) => ({ ...candidate, status: status as Message['status'] }));
  variants.push({ ...candidate, deletedAt: 123 }, { ...candidate, parts: messageParts('  ') },
    { ...candidate, parts: messageParts('x'.repeat(MAX_SUMMARY_CHARACTERS + 1)) },
    { ...candidate, generation: { usage: {}, usageIsFinal: false, finishReason: 'length' } });
  for (const invalid of variants) {
    const prepared = summaryContext([...path, invalid], path.at(-1)!.id, true);
    assert.equal(prepared.summary, undefined); assert.equal(prepared.history.length, path.length);
  }
});

test('a summary replaces only its covered prefix and is a budgeted historical user document, with a full-history opt-out', () => {
  const path = history(), saved = summary(path.slice(0, 2)), messages = [...path, saved], before = structuredClone(messages);
  const prepared = summaryContext(messages, path.at(-1)!.id, true);
  assert.deepEqual(prepared.history.map(({ content }) => content), path.slice(2).map((message) => messageText(message)));
  const built = buildContext(prepared.history, 'new question', config, defaults, summaryPrefix(saved));
  assert.equal(built.messages[0].role, 'user'); assert.match(built.messages[0].content, /42 元/);
  assert.equal(built.estimate.summarizedMessages, 2); assert.equal(built.estimate.summaryId, saved.id);
  assert.ok(built.estimate.summaryTokens! > 0); assert.equal(built.estimate.retainedMessages, 4);
  const oversized = buildContext([], 'new', config, { ...defaults, contextBudget: 1 }, summaryPrefix(saved));
  assert.throws(() => assertContextFits(oversized.estimate), /停用历史摘要/);
  const disabled = summaryContext(messages, path.at(-1)!.id, false);
  assert.equal(disabled.summary, undefined); assert.equal(disabled.history.length, path.length);
  assert.deepEqual(messages, before);
});

test('manual compression covers all prepared input or rejects without losing original history; regeneration does not summarize itself', () => {
  const path = history(); path[0].parts = messageParts('早期的重要事实'.repeat(1000));
  const before = structuredClone(path);
  assert.throws(() => summaryGeneration(path, path[3].id, { ...config, modelMetadata: metadata(2048) }), /完整历史超出/);
  const first = summaryGeneration(path, path[1].id, { ...config, modelMetadata: metadata(100000) });
  assert.deepEqual(first.coverage.sourceIds, path.slice(0, 2).map(({ id }) => id));
  assert.equal(first.estimate.omittedMessages, 0); assert.equal(first.config.systemPrompt, SUMMARY_SYSTEM_PROMPT);
  assert.equal(first.config.maxOutputTokens, 2048); assert.equal(first.config.showReasoning, false);
  assert.equal(first.context[0].content, messageText(path[0]));
  const saved = summary(path.slice(0, 2));
  const incremental = summaryGeneration([...path, saved], path[3].id, { ...config, modelMetadata: metadata(2048) });
  assert.equal(incremental.estimate.summaryId, saved.id); assert.equal(incremental.estimate.summarizedMessages, 2);
  assert.equal(incremental.context[1].content, messageText(path[2])); assert.deepEqual(incremental.coverage.sourceIds, path.slice(0, 4).map(({ id }) => id));
  const repeat = summaryGeneration([...path, saved], path[1].id, { ...config, modelMetadata: metadata(100000) });
  assert.equal(repeat.estimate.summaryId, undefined); assert.equal(repeat.context[0].content, messageText(path[0]));
  assert.throws(() => summaryGeneration([...path, saved], saved.id, config), /已完成的回答/);
  assert.deepEqual(path, before);
});

test('summary suffixes preserve deleted-question filtering even when the question is before the boundary', () => {
  const path = history(), saved = summary(path.slice(0, 2));
  path[2].deletedAt = 123;
  const prepared = summaryContext([...path, saved], path.at(-1)!.id, true);
  assert.deepEqual(prepared.history.map(({ content }) => content), path.slice(4).map((message) => messageText(message)));
});

test('summary coverage and backups reject dangling, reordered, duplicate or private fields and retain recoverable partial metadata', () => {
  const path = history(), saved = summary(path.slice(0, 2));
  assert.equal(v.safeParse(summaryCoverageSchema, saved.summary).success, true);
  for (const invalid of [{ ...saved.summary, sourceIds: [] }, { ...saved.summary, sourceIds: [path[1].id, path[1].id] },
    { ...saved.summary, throughId: crypto.randomUUID() }, { ...saved.summary, apiKey: 'private' }]) assert.equal(v.safeParse(summaryCoverageSchema, invalid).success, false);
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 1,
    conversation: { id: crypto.randomUUID(), title: '摘要', createdAt: 1, updatedAt: 2, settings: defaults, messages: [...path, saved].map(backupMessage) },
    settings: { providers: [], activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: null, showReasoning: false, promptPresets: [] } };
  assert.deepEqual(validateBackup(backup).conversation.messages.at(-1)?.summary, saved.summary);
  const excess = Array.from({ length: MAX_SUMMARIES + 1 }, (_, index) => backupMessage(summary(path.slice(0, 2), index + 10)));
  assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, messages: [...path.map(backupMessage), ...excess] } }), /摘要数量超过/);
  for (const parts of [[], messageParts(' '), messageParts('x'.repeat(MAX_SUMMARY_CHARACTERS + 1))]) assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, messages: [...path.map(backupMessage), { ...backupMessage(saved), parts }] } }), /已完成摘要无效/);
  const partial = backupMessage({ ...saved, status: 'running' });
  assert.equal(partial.status, 'failed'); assert.deepEqual(partial.summary, saved.summary);
  for (const patch of [{ parentId: path[0].id }, { summary: { throughId: path[1].id, sourceIds: [path[1].id] } },
    { summary: { throughId: path[1].id, sourceIds: [crypto.randomUUID(), path[1].id] } }]) {
    assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, messages: [...path.map(backupMessage), { ...backupMessage(saved), ...patch }] } }), /摘要父链无效/);
  }
  assert.deepEqual(branchPath([...path, saved], path[3].id), path.slice(0, 4));
});
