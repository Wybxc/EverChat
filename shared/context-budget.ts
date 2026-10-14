import * as v from 'valibot';
import { branchPath, type ChatInput, type ConversationSettings, type Message, type ProviderConfig, type SubmitInput } from './types';
import { messageText } from './message-content';
import { FALLBACK_MODEL_METADATA } from './model-metadata';

// A bounded, model-independent approximation, not a supplier tokenizer or billing counter.
// Distribute 16 small samples across long text instead of scanning an entire conversation.
export const TOKEN_SAMPLE_UNITS = 256;
export function estimateTextTokens(text: string): number {
  if (!text.length) return 0;
  let weight = 0, sampled = 0;
  const sample = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const code = text.charCodeAt(i);
      if (code <= 127) {
        const ordinary = code === 32 || code >= 9 && code <= 13 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
        weight += ordinary ? 1 / 3 : 1;
      } else weight += code >= 0xd800 && code <= 0xdfff ? 1.5 : 2;
      sampled++;
    }
  };
  if (text.length <= TOKEN_SAMPLE_UNITS) sample(0, text.length);
  else for (let block = 0; block < 16; block++) {
    const start = Math.floor(block * (text.length - 16) / 15);
    sample(start, start + 16);
  }
  return Math.ceil(weight / sampled * text.length);
}

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000_000));
export const contextEstimateSchema = v.strictObject({
  method: v.literal('approximate-v1'), inputTokens: count, systemTokens: count, historyTokens: count, totalTokens: count,
  inputBudget: count, contextWindow: count, outputReserve: count, safetyMargin: count,
  contextScope: v.picklist(['combined', 'input']), windowSource: v.picklist(['manual', 'provider', 'catalog', 'fallback']),
  retainedMessages: count, omittedMessages: count,
});
export type ContextEstimate = v.InferOutput<typeof contextEstimateSchema>;
export class ContextBudgetError extends Error {}

export function contextSource(messages: Message[], input: Pick<SubmitInput, 'content' | 'retryOf' | 'revisionOf' | 'branchHead'>) {
  const previous = input.retryOf ? messages.find((message) => message.id === input.retryOf) : undefined;
  const parent = previous ? messages.find((message) => message.id === previous.parentId) : undefined;
  const original = input.revisionOf ? messages.find((message) => message.id === input.revisionOf) : undefined;
  const latest = [...messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt);
  return { content: parent ? messageText(parent) : input.content?.trim() ?? '',
    parentId: parent ? parent.parentId : original ? original.parentId : input.branchHead ?? latest?.id ?? null };
}

export function contextHistory(messages: Message[], parentId: string | null): ChatInput[] {
  const history = parentId ? branchPath(messages, parentId) : [];
  const deletedUsers = new Set(history.filter((message) => message.role === 'user' && message.deletedAt).map(({ id }) => id));
  return history.filter((message) => message.status === 'completed' && !message.deletedAt
    && !(message.role === 'assistant' && message.parentId && deletedUsers.has(message.parentId)))
    .map((message) => ({ role: message.role, content: messageText(message) }));
}

// Framing varies by protocol/model. Leave slack rather than claim an exact serialization count.
const MESSAGE_OVERHEAD = 8, REQUEST_OVERHEAD = 3;
const historyTokenCache = new WeakMap<ChatInput, { content: string; tokens: number }>();
function historyTokens(message: ChatInput): number {
  const cached = historyTokenCache.get(message);
  if (cached?.content === message.content) return cached.tokens;
  const tokens = estimateTextTokens(message.content) + MESSAGE_OVERHEAD;
  historyTokenCache.set(message, { content: message.content, tokens });
  return tokens;
}
export function buildContext(history: ChatInput[], content: string, config: Pick<ProviderConfig, 'systemPrompt' | 'maxOutputTokens' | 'modelMetadata'>,
  settings: Pick<ConversationSettings, 'recentMessages' | 'contextBudget'>): { messages: ChatInput[]; estimate: ContextEstimate } {
  const metadata = config.modelMetadata ?? { ...FALLBACK_MODEL_METADATA, sources: { contextWindow: 'fallback' as const } };
  const { contextWindow, contextScope } = metadata;
  // Planning reserve only: never turn an unset request output limit into a supplier parameter.
  const outputReserve = config.maxOutputTokens ?? Math.min(metadata.maxOutputTokens, Math.floor(contextWindow / 4));
  const safetyMargin = Math.ceil(contextWindow / 10);
  const capacity = Math.max(0, contextWindow - safetyMargin - (contextScope === 'combined' ? outputReserve : 0));
  const inputBudget = Math.min(capacity, settings.contextBudget ?? capacity);
  const inputTokens = estimateTextTokens(content);
  const systemTokens = config.systemPrompt ? estimateTextTokens(config.systemPrompt) + MESSAGE_OVERHEAD : 0;
  const fixed = inputTokens + MESSAGE_OVERHEAD + systemTokens + REQUEST_OVERHEAD;
  const selected: ChatInput[] = [];
  let retainedTokens = 0;
  // Select a suffix of complete user-led turns. Never cut a message or start on an orphaned answer.
  let end = history.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && history[start].role !== 'user') start--;
    if (history[start].role !== 'user') break;
    if (settings.recentMessages !== null && selected.length + end - start > settings.recentMessages) break;
    let tokens = 0;
    for (let i = start; i < end; i++) tokens += historyTokens(history[i]);
    if (fixed + retainedTokens + tokens > inputBudget) break;
    selected.unshift(...history.slice(start, end)); retainedTokens += tokens; end = start;
  }
  const estimate: ContextEstimate = { method: 'approximate-v1', inputTokens, systemTokens, historyTokens: retainedTokens, totalTokens: fixed + retainedTokens,
    inputBudget, contextWindow, contextScope, outputReserve, safetyMargin, windowSource: metadata.sources.contextWindow,
    retainedMessages: selected.length, omittedMessages: history.length - selected.length };
  return { messages: [...selected, { role: 'user', content }], estimate };
}

export function assertContextFits(estimate: ContextEstimate) {
  if (estimate.totalTokens > estimate.inputBudget) throw new ContextBudgetError(`系统提示词与本次输入约需 ${estimate.totalTokens.toLocaleString('zh-CN')} Tokens，超过上下文预算 ${estimate.inputBudget.toLocaleString('zh-CN')}。请缩短输入或调整预算／输出预留。`);
}
