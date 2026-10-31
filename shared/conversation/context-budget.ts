import { toolDefinitions } from '../tools/definitions';
import { ATTACHMENT_TOOL_NAMES } from '../attachments/tools';
import { resolveDocumentModes } from '../attachments/input-mode';
import * as v from 'valibot';
import { assertDocumentContext, documentTokens, type DocumentPart } from '../attachments/documents';
import { assertImageContext, type ImagePart } from '../attachments/images';
import { AppError, problem, type ErrorIssue } from '../errors/descriptor';
import { FALLBACK_MODEL_METADATA } from '../models/metadata';
import { type ChatInput, type ProviderConfig } from '../providers/types';
import { branchPath } from './branch-path';
import { messageFiles, messageImages, messageText } from './content';
import { MAX_SQL_PAYLOAD_BYTES } from './limits';
import { type ConversationSettings, type Message, type SubmitInput } from './types';

import { estimateTextTokens } from './token-estimate';
export { estimateTextTokens, TOKEN_SAMPLE_UNITS } from './token-estimate';

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const contextEstimateSchema = v.strictObject({
  method: v.literal('approximate-v1'),
  inputTokens: count,
  systemTokens: count,
  historyTokens: count,
  totalTokens: count,
  inputBudget: count,
  contextWindow: count,
  outputReserve: count,
  safetyMargin: count,
  contextScope: v.picklist(['combined', 'input']),
  windowSource: v.picklist([
    'manual',
    'provider',
    'tested',
    'catalog',
    'directory',
    'inferred',
    'fallback',
  ]),
  retainedMessages: count,
  omittedMessages: count,
  summaryTokens: v.optional(count),
  summarizedMessages: v.optional(count),
  summaryId: v.optional(v.pipe(v.string(), v.uuid())),
  imageTokens: v.optional(count),
  documentTokens: v.optional(count),
  toolTokens: v.optional(count),
});
export type ContextEstimate = v.InferOutput<typeof contextEstimateSchema>;
export class ContextBudgetError extends AppError {
  constructor(message: string, issue: ErrorIssue = problem('CONTEXT_INVALID')) {
    super(issue, message);
  }
}

export function contextSource(
  messages: Message[],
  input: Pick<SubmitInput, 'content' | 'retryOf' | 'continueOf' | 'revisionOf' | 'parentId'>,
) {
  const previous =
    input.retryOf || input.continueOf
      ? messages.find((message) => message.id === (input.retryOf ?? input.continueOf))
      : undefined;
  const parent = previous
    ? messages.find((message) => message.id === previous.parentId)
    : undefined;
  const original = input.revisionOf
    ? messages.find((message) => message.id === input.revisionOf)
    : undefined;
  const files = messageFiles(parent ?? original);
  const images = parent ? messageImages(parent) : original ? messageImages(original) : [];
  return {
    content: parent ? messageText(parent) : (input.content?.trim() ?? ''),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    parentId: parent ? parent.parentId : original ? original.parentId : (input.parentId ?? null),
  };
}

export function contextHistory(messages: Message[], parentId: string | null): ChatInput[] {
  const history = parentId ? branchPath(messages, parentId) : [];
  const deletedUsers = new Set(
    history.filter((message) => message.role === 'user' && message.deletedAt).map(({ id }) => id),
  );
  return history
    .filter(
      (message) =>
        message.status === 'completed' &&
        !message.deletedAt &&
        !message.summary &&
        !(message.role === 'assistant' && message.parentId && deletedUsers.has(message.parentId)),
    )
    .map((message) => ({
      role: message.role,
      content: messageText(message),
      source: { kind: 'message' as const, messageId: message.id },
      ...(messageImages(message).length ? { images: messageImages(message) } : {}),
      ...(messageFiles(message).length ? { files: messageFiles(message) } : {}),
    }));
}

// Framing varies by protocol/model. Leave slack rather than claim an exact serialization count.
const MESSAGE_OVERHEAD = 8,
  REQUEST_OVERHEAD = 3;
const historyTokenCache = new WeakMap<
  ChatInput,
  { content: string; documents: number; tokens: number }
>();
function historyTokens(message: ChatInput): number {
  const cached = historyTokenCache.get(message);
  const documents = documentTokens(message.files);
  if (cached?.content === message.content && cached.documents === documents) return cached.tokens;
  const tokens = estimateTextTokens(message.content) + MESSAGE_OVERHEAD + documents;
  historyTokenCache.set(message, { content: message.content, documents, tokens });
  return tokens;
}
function turnStart(history: ChatInput[], end: number) {
  let start = end - 1;
  while (start > 0 && history[start].role !== 'user') start--;
  return history[start]?.role === 'user' ? start : -1;
}
// Count the complete-turn suffix requested by the user, independently of the token budget.
export function historyCountWithinLimit(history: ChatInput[], recentMessages: number | null) {
  let end = history.length,
    retained = 0;
  while (end > 0) {
    const start = turnStart(history, end);
    if (start < 0 || (recentMessages !== null && retained + end - start > recentMessages)) break;
    retained += end - start;
    end = start;
  }
  return retained;
}
export function buildContext(
  history: ChatInput[],
  content: string,
  config: Pick<ProviderConfig, 'systemPrompt' | 'maxOutputTokens' | 'modelMetadata'>,
  settings: Pick<ConversationSettings, 'recentMessages' | 'contextBudget'>,
  summary?: { id: string; content: string; coveredMessages: number; sourceIds?: string[] },
  images: ImagePart[] = [],
  files: DocumentPart[] = [],
  currentSource?: ChatInput['source'],
  pinned: ChatInput[] = [],
  requiredTail: ChatInput[] = [],
): { messages: ChatInput[]; estimate: ContextEstimate; selection: ContextSelection } {
  const metadata = config.modelMetadata ?? {
    ...FALLBACK_MODEL_METADATA,
    sources: { contextWindow: 'fallback' as const },
  };
  const { contextWindow, contextScope } = metadata;
  // Planning reserve only: never turn an unset request output limit into a supplier parameter.
  const outputReserve = config.maxOutputTokens ?? 0;
  const safetyMargin = 0;
  const capacity = Math.max(
    0,
    metadata.sources.contextWindow === 'fallback'
      ? Number.MAX_SAFE_INTEGER
      : contextWindow - (contextScope === 'combined' ? outputReserve : 0),
  );
  const inputBudget = Math.min(capacity, settings.contextBudget ?? capacity);
  // Choose modes before suffix selection so long history files do not force out useful turns.
  const textBase = estimateTextTokens(content) + estimateTextTokens(config.systemPrompt) + 64;
  const groups = resolveDocumentModes(
    [
      files,
      ...requiredTail.map((m) => m.files ?? []),
      ...pinned.map((m) => m.files ?? []),
      ...history.map((m) => m.files ?? []),
    ],
    config,
    Math.max(0, inputBudget - textBase) / 2,
  );
  files = groups[0];
  let groupIndex = 1;
  const replaceFiles = (message: ChatInput): ChatInput => {
    const files = groups[groupIndex++];
    return message.files ? { ...message, files } : message;
  };
  requiredTail = requiredTail.map(replaceFiles);
  pinned = pinned.map(replaceFiles);
  history = history.map(replaceFiles);
  const attachmentToolTokens = groups.some((group) => group.some((f) => f.delivery === 'on_demand'))
    ? estimateTextTokens(JSON.stringify(toolDefinitions(ATTACHMENT_TOOL_NAMES, config))) + 32
    : 0;
  let toolTokens = [
    files,
    ...requiredTail.map((m) => m.files ?? []),
    ...pinned.map((m) => m.files ?? []),
  ].some((group) => group.some((file) => file.delivery === 'on_demand'))
    ? attachmentToolTokens
    : 0;
  const inputTokens = estimateTextTokens(content) + documentTokens(files);
  const systemTokens = config.systemPrompt
    ? estimateTextTokens(config.systemPrompt) + MESSAGE_OVERHEAD
    : 0;
  const summaryTokens = summary ? estimateTextTokens(summary.content) + MESSAGE_OVERHEAD : 0;
  const requiredTokens = requiredTail.reduce((sum, m) => sum + historyTokens(m), 0);
  const fixed =
    inputTokens +
    MESSAGE_OVERHEAD +
    systemTokens +
    REQUEST_OVERHEAD +
    summaryTokens +
    pinned.reduce((sum, m) => sum + historyTokens(m), 0) +
    requiredTokens;
  const selected: ChatInput[] = [];
  let retainedTokens = 0;
  let omittedReason: ContextOmissionReason = 'context_budget';
  // Select a suffix of complete user-led turns. Never cut a message or start on an orphaned answer.
  let end = history.length;
  while (end > 0) {
    const start = turnStart(history, end);
    if (start < 0) {
      omittedReason = 'unavailable';
      break;
    }
    if (
      settings.recentMessages !== null &&
      selected.length + end - start > settings.recentMessages
    ) {
      omittedReason = 'recent_messages';
      break;
    }
    let tokens = 0;
    for (let i = start; i < end; i++) tokens += historyTokens(history[i]);
    const nextTools =
      toolTokens ||
      (history
        .slice(start, end)
        .some((message) => message.files?.some((file) => file.delivery === 'on_demand'))
        ? attachmentToolTokens
        : 0);
    if (fixed + retainedTokens + tokens + nextTools > inputBudget) break;
    toolTokens = nextTools;
    selected.unshift(...history.slice(start, end));
    retainedTokens += tokens;
    end = start;
  }
  const estimate: ContextEstimate = {
    method: 'approximate-v1',
    inputTokens,
    systemTokens,
    historyTokens: retainedTokens + requiredTokens,
    totalTokens: fixed + retainedTokens + toolTokens,
    inputBudget,
    contextWindow,
    contextScope,
    outputReserve,
    safetyMargin,
    windowSource: metadata.sources.contextWindow,
    ...(toolTokens ? { toolTokens } : {}),
    retainedMessages: selected.length + requiredTail.length,
    omittedMessages: history.length - selected.length,
    ...(summary
      ? { summaryTokens, summarizedMessages: summary.coveredMessages, summaryId: summary.id }
      : {}),
  };
  const messages: ChatInput[] = [
    ...(summary
      ? [
          {
            role: 'user' as const,
            content: summary.content,
            source: { kind: 'summary' as const, messageId: summary.id },
          },
        ]
      : []),
    ...pinned,
    ...selected,
    ...requiredTail,
    {
      role: 'user',
      content,
      ...(currentSource ? { source: currentSource } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    },
  ];
  const fileAllowance = messages.reduce((sum, message) => sum + documentTokens(message.files), 0);
  if (fileAllowance) estimate.documentTokens = fileAllowance;
  assertImageContext(messages, config);
  assertDocumentContext(messages);
  return {
    messages,
    estimate,
    selection: {
      omitted: history.slice(0, end).map((input) => ({ input, reason: omittedReason })),
      summarized: summary?.sourceIds ?? [],
    },
  };
}

export type ContextOmissionReason =
  | 'context_budget'
  | 'recent_messages'
  | 'unavailable'
  | 'deleted'
  | 'not_completed'
  | 'deleted_parent'
  | 'superseded_file'
  | 'superseded_summary';
export interface ContextSelection {
  omitted: { input: ChatInput; reason: ContextOmissionReason }[];
  summarized: string[];
}

// Only validate contexts that will actually be persisted, not an intermediate
// planning result that will be replaced by automatic compression.
export function assertStoredContextFits(
  messages: ChatInput[],
  config: Pick<ProviderConfig, 'systemPrompt'>,
) {
  const encoder = new TextEncoder();
  if (
    encoder.encode(JSON.stringify(messages)).byteLength +
      encoder.encode(JSON.stringify(config)).byteLength >
    MAX_SQL_PAYLOAD_BYTES
  )
    throw new ContextBudgetError(
      '本次上下文与供应商配置超过云端单次任务的存储保护大小。请减少携带的历史或先生成摘要。',
    );
}

export function assertContextFits(estimate: ContextEstimate) {
  if (estimate.totalTokens > estimate.inputBudget)
    throw new ContextBudgetError(
      `${estimate.summaryTokens ? '系统提示词、摘要与本次输入' : '系统提示词与本次输入'}约需 ${estimate.totalTokens.toLocaleString('zh-CN')} Tokens，超过上下文预算 ${estimate.inputBudget.toLocaleString('zh-CN')}。请缩短输入${estimate.summaryTokens ? '、重新压缩历史' : ''}或调整预算／输出预留。`,
      problem('CONTEXT_BUDGET_EXCEEDED', {
        estimatedTokens: estimate.totalTokens,
        budgetTokens: estimate.inputBudget,
      }),
    );
}

// Measure the whole available branch for compression, before selecting a bounded raw-history tail.
export function measureContextDemand(
  history: ChatInput[],
  content: string,
  config: Pick<ProviderConfig, 'systemPrompt' | 'maxOutputTokens' | 'modelMetadata'>,
  settings: Pick<ConversationSettings, 'recentMessages' | 'contextBudget'>,
  summary?: { id: string; content: string; coveredMessages: number },
  images: ImagePart[] = [],
  files: DocumentPart[] = [],
  pinned: ChatInput[] = [],
  requiredTail: ChatInput[] = [],
): ContextEstimate {
  const fixed = buildContext(
    [],
    content,
    config,
    settings,
    summary,
    images,
    files,
    undefined,
    pinned,
    requiredTail,
  ).estimate;
  const tokens = history.reduce((total, message) => total + historyTokens(message), 0);
  const fileAllowance =
    documentTokens(files) +
    pinned.reduce((sum, message) => sum + documentTokens(message.files), 0) +
    requiredTail.reduce((sum, message) => sum + documentTokens(message.files), 0) +
    history.reduce((sum, message) => sum + documentTokens(message.files), 0);
  return {
    ...fixed,
    historyTokens: fixed.historyTokens + tokens,
    totalTokens: fixed.totalTokens + tokens,
    retainedMessages: fixed.retainedMessages + history.length,
    omittedMessages: 0,
    ...(fileAllowance ? { documentTokens: fileAllowance } : {}),
  };
}
