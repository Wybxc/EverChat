import * as v from 'valibot';
import {
  MAX_MESSAGE_TEXT_BYTES,
  MAX_SYSTEM_PROMPT_LENGTH,
  messageTextFits,
} from '../../shared/conversation/limits';

const uuid = v.pipe(v.string(), v.uuid());
const handle = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const wait = v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20_000)), 10_000);
export const MCP_TOOL_NAMES = [
  'everchat_help',
  'everchat_models_list',
  'everchat_chat',
  'everchat_run_get',
  'everchat_run_cancel',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export const helpInputSchema = v.strictObject({ tool: v.optional(v.picklist(MCP_TOOL_NAMES)) });
export const helpResultSchema = v.strictObject({
  workflow: v.array(v.string()),
  notes: v.array(v.string()),
  tools: v.array(
    v.strictObject({
      name: v.picklist(MCP_TOOL_NAMES),
      description: v.string(),
      inputSchema: v.record(v.string(), v.unknown()),
      examples: v.array(
        v.strictObject({
          description: v.string(),
          arguments: v.record(v.string(), v.unknown()),
        }),
      ),
      notes: v.array(v.string()),
    }),
  ),
});
export type HelpResult = v.InferOutput<typeof helpResultSchema>;
export const chatSchema = v.strictObject({
  requestId: uuid,
  prompt: v.pipe(
    v.string(),
    v.maxLength(MAX_MESSAGE_TEXT_BYTES),
    v.check((text) => Boolean(text.trim()) && messageTextFits(text)),
  ),
  modelRef: v.optional(handle),
  continuation: v.optional(handle),
  presetId: v.optional(uuid),
  systemPrompt: v.optional(v.pipe(v.string(), v.maxLength(MAX_SYSTEM_PROMPT_LENGTH))),
  reasoningEffort: v.optional(
    v.picklist(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  ),
  temperature: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2))),
  topP: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
  contextBudget: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  ),
  maxOutputTokens: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  ),
  recentMessages: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  ),
  webSearch: v.optional(v.boolean()),
  waitMs: wait,
});
export type ChatArguments = v.InferOutput<typeof chatSchema>;
export const getSchema = v.strictObject({
  runRef: handle,
  waitMs: wait,
  outputCursor: v.optional(handle),
  includeReasoning: v.optional(v.boolean(), false),
  reasoningCursor: v.optional(handle),
});
export type GetArguments = v.InferOutput<typeof getSchema>;
export const cancelSchema = v.strictObject({ runRef: handle });
export const emptySchema = v.strictObject({});
export const errorSchema = v.strictObject({
  code: v.string(),
  message: v.string(),
  stage: v.string(),
  retryable: v.boolean(),
  httpStatus: v.optional(v.number()),
});
export type McpFailure = v.InferOutput<typeof errorSchema>;
export class McpError extends Error {
  constructor(public readonly detail: McpFailure) {
    super(detail.message);
  }
}
export function fail(code: string, message: string, stage = 'admission', retryable = false): never {
  throw new McpError({ code, message, stage, retryable });
}
const modelSchema = v.strictObject({
  ref: v.string(),
  id: v.string(),
  name: v.string(),
  providerName: v.string(),
});
export type McpModel = v.InferOutput<typeof modelSchema>;
const pageSchema = v.strictObject({
  text: v.string(),
  hasMore: v.boolean(),
  nextCursor: v.optional(v.string()),
});
export const runSchema = v.strictObject({
  status: v.picklist(['accepted', 'running', 'completed', 'interrupted', 'failed', 'cancelled']),
  runRef: v.string(),
  conversationId: uuid,
  assistantMessageId: v.optional(uuid),
  continuation: v.optional(v.string()),
  model: modelSchema,
  output: pageSchema,
  reasoning: v.optional(pageSchema),
  finishReason: v.optional(v.string()),
  usage: v.strictObject({
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    uncachedInputTokens: v.optional(v.number()),
    textOutputTokens: v.optional(v.number()),
    toolInputTokens: v.optional(v.number()),
    isFinal: v.boolean(),
  }),
  error: v.optional(errorSchema),
  url: v.string(),
});
export type RunResult = v.InferOutput<typeof runSchema>;
export const modelsSchema = v.strictObject({
  models: v.array(
    v.strictObject({
      ...modelSchema.entries,
      reasoning: v.boolean(),
      reasoningEfforts: v.array(v.string()),
      contextWindow: v.nullable(v.number()),
      maxOutputTokens: v.nullable(v.number()),
    }),
  ),
  presets: v.array(v.strictObject({ id: uuid, name: v.string() })),
  defaultModelRef: v.optional(v.string()),
});
export type ModelsResult = v.InferOutput<typeof modelsSchema>;

// Versioned, bounded references are addresses, never authorization capabilities.
export function encodeRef(kind: string, value: string[]) {
  return `${kind}_${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}
export function decodeRef(kind: string, value: string, length: number): string[] {
  try {
    if (!value.startsWith(`${kind}_`) || value.length > 2048) throw new Error();
    const encoded = value.slice(kind.length + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== length ||
      !parsed.every((item) => typeof item === 'string')
    )
      throw new Error();
    return parsed;
  } catch {
    return fail('INVALID_REFERENCE', 'Invalid or unsupported reference.');
  }
}
