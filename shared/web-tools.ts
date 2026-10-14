import * as v from 'valibot';
import type { ResolvedModelMetadata } from './types';

export const WEB_TOOL_NAMES = ['web_search', 'read_webpage'] as const;
export type WebToolName = typeof WEB_TOOL_NAMES[number];
export const MAX_TOOL_CALLS_PER_TURN = 2;
export const MAX_TOOL_EXCHANGES = 3;
export const MAX_TOOL_INPUT_BYTES = 8 * 1024;
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_TOOL_SOURCES = 5;
export const MAX_TOOL_SOURCE_CHARACTERS = 12_000;

// Fetch targets and source links use the same conservative public HTTPS rules.
// DNS/network enforcement belongs to the configured service, not this syntactic check.
export function publicWebUrl(value: string): boolean {
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(host)
      && host.split('.').every((label) => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'))
      && !/(?:^|\.)(?:localhost|local|internal|lan|invalid|test|home\.arpa)$/.test(host);
  } catch { return false; }
}

const safeText = (limit: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(limit),
  v.check((text) => Boolean(text.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)));
const callId = v.pipe(v.string(), v.minLength(1), v.maxLength(256), v.check((id) => !/[\u0000-\u0020\u007f]/.test(id)));
const name = v.picklist(WEB_TOOL_NAMES);
const url = v.pipe(v.string(), v.check(publicWebUrl, '只允许公开 HTTPS 网页地址。'));
export function validateWebToolIdentity(id: string, toolName: string, enabled: readonly WebToolName[]) {
  if (!v.is(callId, id) || !v.is(name, toolName) || !enabled.includes(toolName)) throw new Error('模型返回了未启用的工具或无效调用标识。');
}
export const webToolCallSchema = v.variant('name', [
  v.strictObject({ id: callId, name: v.literal('web_search'), input: v.strictObject({ query: safeText(500) }) }),
  v.strictObject({ id: callId, name: v.literal('read_webpage'), input: v.strictObject({ url }) }),
]);
export type WebToolCall = v.InferOutput<typeof webToolCallSchema>;
const sourceSchema = v.strictObject({ title: safeText(300), url, content: safeText(MAX_TOOL_SOURCE_CHARACTERS) });
export const webToolOutcomeSchema = v.variant('status', [
  v.strictObject({ id: callId, name, status: v.literal('completed'), sources: v.pipe(v.array(sourceSchema), v.maxLength(MAX_TOOL_SOURCES),
    v.check((sources) => sources.reduce((total, source) => total + source.content.length, 0) <= MAX_TOOL_SOURCE_CHARACTERS)) }),
  v.strictObject({ id: callId, name, status: v.literal('failed'), error: safeText(500) }),
]);
export type WebToolOutcome = v.InferOutput<typeof webToolOutcomeSchema>;

export function validateWebToolCall(value: unknown, enabled: readonly WebToolName[]): WebToolCall {
  const result = v.safeParse(webToolCallSchema, value);
  if (!result.success || !enabled.includes(result.output.name) || new TextEncoder().encode(JSON.stringify(result.output.input)).byteLength > MAX_TOOL_INPUT_BYTES) {
    throw new Error('模型返回了未启用的工具或无效参数。');
  }
  return result.output;
}
export function validateWebToolOutcome(value: unknown): WebToolOutcome {
  const result = v.safeParse(webToolOutcomeSchema, value);
  if (!result.success || new TextEncoder().encode(JSON.stringify(result.output)).byteLength > MAX_TOOL_RESULT_BYTES) throw new Error('工具结果无效或超过大小限制。');
  return result.output;
}
export function assertWebToolSupport(metadata: ResolvedModelMetadata | undefined, enabled: readonly WebToolName[]) {
  if (!enabled.length || enabled.length > WEB_TOOL_NAMES.length || new Set(enabled).size !== enabled.length || enabled.some((name) => !WEB_TOOL_NAMES.includes(name))) throw new Error('工具选择无效。');
  if (!metadata?.toolCalls) throw new Error('当前模型未声明支持工具调用。');
}
