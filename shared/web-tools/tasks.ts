import * as v from 'valibot';
import { AppError, errorIssueSchema, problem } from '../errors/descriptor';
import { canAttemptCapability } from '../models/metadata';
import type { ResolvedModelMetadata } from '../models/types';

export const WEB_TOOL_NAMES = ['web_search', 'read_webpage'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
export const MAX_TOOL_CALLS_PER_TURN = 2;
// Leave room for an 8192-character URL, JSON escaping and UTF-8 encoding.
export const MAX_TOOL_INPUT_BYTES = 64 * 1024;
export const MAX_WEB_URL_CHARACTERS = 8192;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_TOOL_SOURCES = 5;
export const MAX_TOOL_SOURCE_CHARACTERS = 12_000;

// Fetch targets and citations are public pages, not credential-bearing service endpoints.
// DNS/network enforcement belongs to the configured service, not this syntactic check.
export function publicWebUrl(value: string): boolean {
  if (value.length > MAX_WEB_URL_CHARACTERS || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port &&
      host.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(host) &&
      host
        .split('.')
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith('-') &&
            !label.endsWith('-'),
        ) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|invalid|test|home\.arpa)$/.test(host)
    );
  } catch {
    return false;
  }
}

const safeText = (limit: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(limit),
    v.regex(/^(?=[\s\S]*\S)[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/),
  );
const callId = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.check((id) => !/[\u0000-\u0020\u007f]/.test(id)),
);
const toolName = v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[a-zA-Z0-9_-]+$/));
const name = v.picklist(WEB_TOOL_NAMES);
const webUrlInput = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WEB_URL_CHARACTERS));
const url = v.pipe(webUrlInput, v.check(publicWebUrl, '只允许公开 HTTP 或 HTTPS 网页地址。'));
// Serializable model constraints. Network-target policy remains a business check.
export const webToolInputSchemas = {
  web_search: v.strictObject({ query: safeText(500) }),
  read_webpage: v.strictObject({ url: webUrlInput }),
};
export function webToolInputSchemasFor(provider?: 'tavily' | 'deepseek') {
  return provider === 'deepseek'
    ? {
        ...webToolInputSchemas,
        web_search: v.strictObject({
          query: v.pipe(
            safeText(256),
            v.check((query) => [...query].length <= 128, 'query 最多 128 个 Unicode 字符。'),
          ),
        }),
      }
    : webToolInputSchemas;
}
export function validateWebToolIdentity(id: string, toolName: string) {
  if (!v.is(callId, id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(toolName))
    throw new AppError(problem('TOOL_INVALID'), '模型返回了未启用的工具或无效调用标识。');
}
const webToolCallSchema = v.variant('name', [
  v.strictObject({
    id: callId,
    name: v.literal('web_search'),
    input: webToolInputSchemas.web_search,
  }),
  v.strictObject({
    id: callId,
    name: v.literal('read_webpage'),
    input: v.pipe(
      webToolInputSchemas.read_webpage,
      v.check((input) => publicWebUrl(input.url), '只允许公开 HTTP 或 HTTPS 网页地址。'),
    ),
  }),
]);
export type WebToolCall = v.InferOutput<typeof webToolCallSchema>;
const jsonInput = v.custom<unknown>((value) => {
  const json = (value: unknown, depth: number): boolean => {
    if (depth > 20) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => json(item, depth + 1));
    return (
      !!value &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => json(item, depth + 1))
    );
  };
  return json(value, 0);
});
const invalidCallSchema = v.strictObject({
  id: callId,
  name: toolName,
  input: jsonInput,
  invalid: v.literal(true),
  error: safeText(500),
});
const candidateSchema = v.union([webToolCallSchema, invalidCallSchema]);
export type WebToolCandidate =
  (WebToolCall & { invalid?: never }) | v.InferOutput<typeof invalidCallSchema>;
export function validateWebToolCandidate(
  value: unknown,
  enabled: readonly WebToolName[],
): WebToolCandidate {
  const result = v.safeParse(candidateSchema, value);
  if (
    !result.success ||
    new TextEncoder().encode(JSON.stringify(result.output.input)).byteLength > MAX_TOOL_INPUT_BYTES
  )
    throw new AppError(problem('TOOL_INVALID'), '工具候选调用无效或超过大小限制。');
  if (!('invalid' in result.output)) validateWebToolCall(result.output, enabled);
  return result.output;
}
export function webToolInputText(call: WebToolCandidate): string {
  return call.invalid
    ? typeof call.input === 'string'
      ? call.input
      : JSON.stringify(call.input)
    : call.name === 'web_search'
      ? call.input.query
      : call.input.url;
}
const sourceSchema = v.strictObject({
  title: safeText(300),
  url,
  content: safeText(MAX_TOOL_SOURCE_CHARACTERS),
});
const webToolOutcomeSchema = v.variant('status', [
  v.strictObject({
    id: callId,
    name,
    status: v.literal('completed'),
    sources: v.pipe(
      v.array(sourceSchema),
      v.maxLength(MAX_TOOL_SOURCES),
      v.check(
        (sources) =>
          sources.reduce((total, source) => total + source.content.length, 0) <=
          MAX_TOOL_SOURCE_CHARACTERS,
      ),
    ),
    warnings: v.optional(v.pipe(v.array(safeText(200)), v.maxLength(5))),
  }),
  v.strictObject({
    id: callId,
    name: toolName,
    status: v.literal('failed'),
    error: safeText(500),
    issue: v.optional(errorIssueSchema),
    failure: v.optional(
      v.strictObject({
        provider: v.picklist(['tavily', 'deepseek']),
        code: v.picklist([
          'CONFIGURATION',
          'INVALID_INPUT',
          'AUTHENTICATION',
          'BALANCE',
          'RATE_LIMIT',
          'PAGE_UNAVAILABLE',
          'SERVICE_UNAVAILABLE',
          'INVALID_RESULT',
          'TIMEOUT',
        ]),
        httpStatus: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
        terminal: v.boolean(),
      }),
    ),
  }),
]);
export type WebToolOutcome = v.InferOutput<typeof webToolOutcomeSchema>;
export type WebToolFailure = NonNullable<Extract<WebToolOutcome, { status: 'failed' }>['failure']>;
export interface PublicToolCall {
  round: number;
  call: WebToolCandidate;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: WebToolOutcome;
}
export interface PublicToolTask {
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  round: number;
  calls: PublicToolCall[];
  /** UTF-16 offsets in the message's cumulative public reasoning, one per tool round. */
  reasoningBreaks?: ReasoningBreak[];
}
export interface ReasoningBreak {
  round: number;
  reasoningEnd: number;
}

export function validReasoningBreaks(task: PublicToolTask, reasoning?: string): boolean {
  const breaks = task.reasoningBreaks;
  if (breaks === undefined) return true; // Historical messages have no ordering information.
  const rounds = new Set(task.calls.map((item) => item.round));
  return (
    breaks.length === rounds.size &&
    breaks.every(({ round, reasoningEnd }, index) => {
      if (
        !rounds.has(round) ||
        !Number.isSafeInteger(round) ||
        round < 0 ||
        round > task.round ||
        !Number.isSafeInteger(reasoningEnd) ||
        reasoningEnd < 0 ||
        (index > 0 &&
          (round <= breaks[index - 1].round || reasoningEnd < breaks[index - 1].reasoningEnd))
      )
        return false;
      if (reasoning === undefined) return true;
      const before = reasoning.charCodeAt(reasoningEnd - 1),
        after = reasoning.charCodeAt(reasoningEnd);
      return (
        reasoningEnd <= reasoning.length &&
        !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
      );
    })
  );
}
const round = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const publicToolTaskSchema = v.pipe(
  v.strictObject({
    status: v.picklist(['active', 'completed', 'failed', 'cancelled']),
    round,
    reasoningBreaks: v.optional(
      v.array(
        v.strictObject({
          round,
          reasoningEnd: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        }),
      ),
    ),
    calls: v.array(
      v.strictObject({
        round,
        call: candidateSchema,
        state: v.picklist(['queued', 'running', 'completed', 'failed', 'cancelled']),
        result: v.optional(webToolOutcomeSchema),
      }),
    ),
  }),
  v.check(
    (task) =>
      validReasoningBreaks(task) &&
      new Set(task.calls.map((item) => item.call.id)).size === task.calls.length &&
      task.calls.every((item) => {
        if (
          item.round > task.round ||
          task.calls.filter((candidate) => candidate.round === item.round).length >
            MAX_TOOL_CALLS_PER_TURN ||
          (task.status !== 'active' && ['queued', 'running'].includes(item.state)) ||
          (task.status === 'completed' && item.state === 'cancelled') ||
          ('invalid' in item.call && item.state !== 'failed')
        )
          return false;
        try {
          validateWebToolCandidate(item.call, WEB_TOOL_NAMES);
          if (item.result) validateWebToolOutcome(item.result);
        } catch {
          return false;
        }
        if (item.state === 'completed' || item.state === 'failed')
          return (
            item.result?.status === item.state &&
            item.result.id === item.call.id &&
            item.result.name === item.call.name
          );
        return item.result === undefined;
      }),
    '工具过程与结果的对应关系无效。',
  ),
);

export function validateWebToolCall(value: unknown, enabled: readonly WebToolName[]): WebToolCall {
  const result = v.safeParse(webToolCallSchema, value);
  if (
    !result.success ||
    !enabled.includes(result.output.name) ||
    new TextEncoder().encode(JSON.stringify(result.output.input)).byteLength > MAX_TOOL_INPUT_BYTES
  ) {
    throw new AppError(problem('TOOL_INVALID'), '模型返回了未启用的工具或无效参数。');
  }
  return result.output;
}
export function validateWebToolOutcome(value: unknown): WebToolOutcome {
  const result = v.safeParse(webToolOutcomeSchema, value);
  if (
    !result.success ||
    new TextEncoder().encode(JSON.stringify(result.output)).byteLength > MAX_TOOL_RESULT_BYTES
  )
    throw new AppError(problem('REQUEST_TOO_LARGE'), '工具结果无效或超过大小限制。');
  return result.output;
}
export function assertWebToolSupport(
  metadata: ResolvedModelMetadata | undefined,
  enabled: readonly WebToolName[],
) {
  if (
    !enabled.length ||
    enabled.length > WEB_TOOL_NAMES.length ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !WEB_TOOL_NAMES.includes(name))
  )
    throw new AppError(problem('TOOL_INVALID'), '工具选择无效。');
  if (!canAttemptCapability(metadata, 'toolCalls'))
    throw new AppError(problem('MODEL_TOOLS_UNSUPPORTED'), '当前模型不支持工具调用。');
}
