import * as v from 'valibot';
import { AppError, errorIssueSchema, problem } from '../errors/descriptor';
import { canAttemptCapability } from '../models/metadata';
import type { ResolvedModelMetadata } from '../models/types';

export const WEB_TOOL_NAMES = ['web_search', 'read_webpage'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
export const MAX_TOOL_CALLS_PER_TURN = 2;
export const MAX_TOOL_INPUT_BYTES = 8 * 1024;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_TOOL_SOURCES = 5;
export const MAX_TOOL_SOURCE_CHARACTERS = 12_000;

// Fetch targets and source links use the same conservative public HTTPS rules.
// DNS/network enforcement belongs to the configured service, not this syntactic check.
export function publicWebUrl(value: string): boolean {
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
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
    v.check(
      (text) =>
        Boolean(text.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),
    ),
  );
const callId = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.check((id) => !/[\u0000-\u0020\u007f]/.test(id)),
);
const name = v.picklist(WEB_TOOL_NAMES);
const url = v.pipe(v.string(), v.check(publicWebUrl, '只允许公开 HTTPS 网页地址。'));
export function validateWebToolIdentity(
  id: string,
  toolName: string,
  enabled: readonly WebToolName[],
) {
  if (!v.is(callId, id) || !v.is(name, toolName) || !enabled.includes(toolName))
    throw new AppError(problem('TOOL_INVALID'), '模型返回了未启用的工具或无效调用标识。');
}
const webToolCallSchema = v.variant('name', [
  v.strictObject({
    id: callId,
    name: v.literal('web_search'),
    input: v.strictObject({ query: safeText(500) }),
  }),
  v.strictObject({ id: callId, name: v.literal('read_webpage'), input: v.strictObject({ url }) }),
]);
export type WebToolCall = v.InferOutput<typeof webToolCallSchema>;
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
  }),
  v.strictObject({
    id: callId,
    name,
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
  call: WebToolCall;
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
        call: webToolCallSchema,
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
          (task.status === 'completed' && item.state === 'cancelled')
        )
          return false;
        try {
          validateWebToolCall(item.call, WEB_TOOL_NAMES);
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
