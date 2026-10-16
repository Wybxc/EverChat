import { assertDocumentContext, documentTokens, type DocumentPart } from './documents';
import * as v from 'valibot';
import { branchPath, type ChatInput, type ConversationSettings, type Message, type ProviderConfig, type SubmitInput } from './types';
import { messageFiles, messageImages, messageText } from './message-content';
import { assertImageContext, imageTokens, type ImagePart } from './images';
import { FALLBACK_MODEL_METADATA } from './model-metadata';

import { estimateTextTokens } from './token-estimate';
export { estimateTextTokens, TOKEN_SAMPLE_UNITS } from './token-estimate';

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000_000));
export const contextEstimateSchema = v.strictObject({
  method: v.literal('approximate-v1'), inputTokens: count, systemTokens: count, historyTokens: count, totalTokens: count,
  inputBudget: count, contextWindow: count, outputReserve: count, safetyMargin: count,
  contextScope: v.picklist(['combined', 'input']), windowSource: v.picklist(['manual', 'provider', 'tested', 'catalog', 'directory', 'inferred', 'fallback']),
  retainedMessages: count, omittedMessages: count,
  summaryTokens: v.optional(count), summarizedMessages: v.optional(count), summaryId: v.optional(v.pipe(v.string(), v.uuid())),
  imageTokens: v.optional(count),
  documentTokens: v.optional(count),
  toolTokens: v.optional(count),
});
export type ContextEstimate = v.InferOutput<typeof contextEstimateSchema>;
export class ContextBudgetError extends Error {}

export function contextSource(messages: Message[], input: Pick<SubmitInput, 'content' | 'retryOf' | 'revisionOf' | 'parentId'>) {
  const previous = input.retryOf ? messages.find((message) => message.id === input.retryOf) : undefined;
  const parent = previous ? messages.find((message) => message.id === previous.parentId) : undefined;
  const original = input.revisionOf ? messages.find((message) => message.id === input.revisionOf) : undefined;
  const files = messageFiles(parent ?? original);
  const images = parent ? messageImages(parent) : original ? messageImages(original) : [];
  return { content: parent ? messageText(parent) : input.content?.trim() ?? '',
    ...(images.length ? { images } : {}), ...(files.length ? { files } : {}),
    parentId: parent ? parent.parentId : original ? original.parentId : input.parentId ?? null };
}

export function contextHistory(messages: Message[], parentId: string | null): ChatInput[] {
  const history = parentId ? branchPath(messages, parentId) : [];
  const deletedUsers = new Set(history.filter((message) => message.role === 'user' && message.deletedAt).map(({ id }) => id));
  return history.filter((message) => message.status === 'completed' && !message.deletedAt && !message.summary
    && !(message.role === 'assistant' && message.parentId && deletedUsers.has(message.parentId)))
    .map((message) => ({ role: message.role, content: messageText(message), ...(messageImages(message).length ? { images: messageImages(message) } : {}), ...(messageFiles(message).length ? { files: messageFiles(message) } : {}) }));
}

// Framing varies by protocol/model. Leave slack rather than claim an exact serialization count.
const MESSAGE_OVERHEAD = 8, REQUEST_OVERHEAD = 3;
const historyTokenCache = new WeakMap<ChatInput, { content: string; images: number; tokens: number }>();
function historyTokens(message: ChatInput): number {
  const cached = historyTokenCache.get(message);
  const images = imageTokens(message.images) + documentTokens(message.files);
  if (cached?.content === message.content && cached.images === images) return cached.tokens;
  const tokens = estimateTextTokens(message.content) + MESSAGE_OVERHEAD + images;
  historyTokenCache.set(message, { content: message.content, images, tokens });
  return tokens;
}
function turnStart(history: ChatInput[], end: number) {
  let start = end - 1;
  while (start > 0 && history[start].role !== 'user') start--;
  return history[start]?.role === 'user' ? start : -1;
}
// Count the complete-turn suffix requested by the user, independently of the token budget.
export function historyCountWithinLimit(history: ChatInput[], recentMessages: number | null) {
  let end = history.length, retained = 0;
  while (end > 0) {
    const start = turnStart(history, end);
    if (start < 0 || recentMessages !== null && retained + end - start > recentMessages) break;
    retained += end - start; end = start;
  }
  return retained;
}
export function buildContext(history: ChatInput[], content: string, config: Pick<ProviderConfig, 'systemPrompt' | 'maxOutputTokens' | 'modelMetadata'>,
  settings: Pick<ConversationSettings, 'recentMessages' | 'contextBudget'>,
  summary?: { id: string; content: string; coveredMessages: number }, images: ImagePart[] = [], files: DocumentPart[] = []): { messages: ChatInput[]; estimate: ContextEstimate } {
  const metadata = config.modelMetadata ?? { ...FALLBACK_MODEL_METADATA, sources: { contextWindow: 'fallback' as const } };
  const { contextWindow, contextScope } = metadata;
  // Planning reserve only: never turn an unset request output limit into a supplier parameter.
  const outputReserve = config.maxOutputTokens ?? Math.min(metadata.maxOutputTokens, Math.floor(contextWindow / 4));
  const safetyMargin = Math.ceil(contextWindow / 10);
  const capacity = Math.max(0, contextWindow - safetyMargin - (contextScope === 'combined' ? outputReserve : 0));
  const inputBudget = Math.min(capacity, settings.contextBudget ?? capacity);
  const inputTokens = estimateTextTokens(content) + imageTokens(images) + documentTokens(files);
  const systemTokens = config.systemPrompt ? estimateTextTokens(config.systemPrompt) + MESSAGE_OVERHEAD : 0;
  const summaryTokens = summary ? estimateTextTokens(summary.content) + MESSAGE_OVERHEAD : 0;
  const fixed = inputTokens + MESSAGE_OVERHEAD + systemTokens + REQUEST_OVERHEAD + summaryTokens;
  const selected: ChatInput[] = [];
  let retainedTokens = 0;
  // Select a suffix of complete user-led turns. Never cut a message or start on an orphaned answer.
  let end = history.length;
  while (end > 0) {
    const start = turnStart(history, end);
    if (start < 0) break;
    if (settings.recentMessages !== null && selected.length + end - start > settings.recentMessages) break;
    let tokens = 0;
    for (let i = start; i < end; i++) tokens += historyTokens(history[i]);
    if (fixed + retainedTokens + tokens > inputBudget) break;
    selected.unshift(...history.slice(start, end)); retainedTokens += tokens; end = start;
  }
  const estimate: ContextEstimate = { method: 'approximate-v1', inputTokens, systemTokens, historyTokens: retainedTokens, totalTokens: fixed + retainedTokens,
    inputBudget, contextWindow, contextScope, outputReserve, safetyMargin, windowSource: metadata.sources.contextWindow,
    retainedMessages: selected.length, omittedMessages: history.length - selected.length,
    ...(summary ? { summaryTokens, summarizedMessages: summary.coveredMessages, summaryId: summary.id } : {}) };
  const messages: ChatInput[] = [...(summary ? [{ role: 'user' as const, content: summary.content }] : []), ...selected, { role: 'user', content, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }];
  const imageAllowance = messages.reduce((sum, message) => sum + imageTokens(message.images), 0);
  if (imageAllowance) estimate.imageTokens = imageAllowance;
  const fileAllowance = messages.reduce((sum, message) => sum + documentTokens(message.files), 0);
  if (fileAllowance) estimate.documentTokens = fileAllowance;
  assertImageContext(messages, config); assertDocumentContext(messages);
  return { messages, estimate };
}

export function assertContextFits(estimate: ContextEstimate) {
  if (estimate.totalTokens > estimate.inputBudget) throw new ContextBudgetError(`${estimate.summaryTokens ? '系统提示词、摘要与本次输入' : '系统提示词与本次输入'}约需 ${estimate.totalTokens.toLocaleString('zh-CN')} Tokens，超过上下文预算 ${estimate.inputBudget.toLocaleString('zh-CN')}。请缩短输入${estimate.summaryTokens ? '、停用历史摘要' : ''}或调整预算／输出预留。`);
}

// Measure the whole available branch for compression, before selecting a bounded raw-history tail.
export function measureContextDemand(history: ChatInput[], content: string, config: Pick<ProviderConfig, 'systemPrompt' | 'maxOutputTokens' | 'modelMetadata'>,
  settings: Pick<ConversationSettings, 'recentMessages' | 'contextBudget'>, summary?: { id: string; content: string; coveredMessages: number }, images: ImagePart[] = [], files: DocumentPart[] = []): ContextEstimate {
  const fixed = buildContext([], content, config, settings, summary, images, files).estimate;
  const tokens = history.reduce((total, message) => total + historyTokens(message), 0);
  const imageAllowance = imageTokens(images) + history.reduce((sum, message) => sum + imageTokens(message.images), 0);
  const fileAllowance = documentTokens(files) + history.reduce((sum, message) => sum + documentTokens(message.files), 0);
  return { ...fixed, historyTokens: tokens, totalTokens: fixed.totalTokens + tokens, retainedMessages: history.length, omittedMessages: 0,
    ...(imageAllowance ? { imageTokens: imageAllowance } : {}), ...(fileAllowance ? { documentTokens: fileAllowance } : {}) };
}
