import {
  MAX_MESSAGE_TEXT_BYTES,
  MESSAGE_TEXT_LIMIT_MESSAGE,
  jsonTextBytes,
  textWithinBytes,
} from '../conversation/limits';
import { AppError, problem } from '../errors/descriptor';
import type { ProviderKind } from '../providers/types';

export const MAX_EVENT_CHARACTERS = 1024 * 1024;
export const FINISH_REASONS = [
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];
export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  uncachedInputTokens?: number;
  textOutputTokens?: number;
  toolInputTokens?: number;
}
export type GenerationEvent =
  | { type: 'text' | 'reasoning'; text: string; replace?: true }
  | { type: 'usage'; usage: StreamUsage }
  | {
      type: 'finish';
      reason: FinishReason;
      rawReason?: string;
      message?: string;
      usage: StreamUsage;
      usageIsFinal: boolean;
    };
export interface StreamState {
  protocol: ProviderKind;
  showReasoning: boolean;
  tail: string;
  utf8: string;
  started: boolean;
  done: boolean;
  finishReason?: FinishReason;
  rawFinishReason?: string;
  finishMessage?: string;
  failure?: string;
  textDeltas: number;
  reasoningDeltas: number;
  usage: StreamUsage;
  usageIsFinal: boolean;
}
type ParsedDelta = { kind: 'content' | 'reasoning'; text: string; replace?: true };
const usageKeys = new Set<keyof StreamUsage>([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
  'uncachedInputTokens',
  'textOutputTokens',
  'toolInputTokens',
]);
export const encodeBytes = (bytes: Uint8Array): string => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
};
export const decodeBytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
export const encodeGenerationEvent = (event: GenerationEvent) =>
  new TextEncoder().encode(JSON.stringify(event) + '\n');
export class StreamParseError extends AppError {
  constructor(message: string) {
    super(problem('STREAM_INVALID'), message);
  }
}

// This decodes EverChat events only. Provider protocols and private SDK metadata
// never enter the browser or a public generation checkpoint.
export class ProviderStream {
  content: string;
  reasoning: string;
  private state: StreamState;
  private deltas: ParsedDelta[] = [];
  private contentBytes: number;
  private reasoningBytes: number;
  constructor(
    protocol: ProviderKind,
    showReasoning: boolean,
    checkpoint?: StreamState,
    content = '',
    reasoning = '',
  ) {
    this.content = content;
    this.reasoning = reasoning;
    this.contentBytes = jsonTextBytes(content);
    this.reasoningBytes = jsonTextBytes(reasoning);
    this.state = checkpoint
      ? structuredClone(checkpoint)
      : {
          protocol,
          showReasoning,
          tail: '',
          utf8: '',
          started: false,
          done: false,
          textDeltas: 0,
          reasoningDeltas: 0,
          usage: {},
          usageIsFinal: false,
        };
    if (this.state.protocol !== protocol || this.state.showReasoning !== showReasoning)
      throw new StreamParseError('流协议状态不一致。');
  }
  checkpoint(): StreamState {
    return structuredClone(this.state);
  }
  get failed() {
    return Boolean(this.state.failure);
  }
  drainDeltas(): ParsedDelta[] {
    const deltas = this.deltas;
    this.deltas = [];
    return deltas;
  }
  feed(bytes: Uint8Array) {
    if (this.failed) return;
    try {
      const pending = decodeBytes(this.state.utf8),
        input = new Uint8Array(pending.length + bytes.length);
      input.set(pending);
      input.set(bytes, pending.length);
      let cut = input.length,
        start = input.length - 1;
      while (start >= 0 && (input[start] & 0xc0) === 0x80) start--;
      if (start >= 0) {
        const lead = input[start],
          expected =
            lead >= 0xf0 && lead <= 0xf4
              ? 4
              : lead >= 0xe0 && lead <= 0xef
                ? 3
                : lead >= 0xc2 && lead <= 0xdf
                  ? 2
                  : 1;
        if (input.length - start < expected) cut = start;
      }
      const text =
        this.state.tail +
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.subarray(0, cut));
      this.state.utf8 = encodeBytes(input.subarray(cut));
      let at = 0;
      for (let end = text.indexOf('\n'); end !== -1 && !this.failed; end = text.indexOf('\n', at)) {
        if (end - at > MAX_EVENT_CHARACTERS) {
          this.fail('应用流事件超过解析缓冲大小。');
          break;
        }
        this.event(JSON.parse(text.slice(at, end)));
        at = end + 1;
      }
      this.state.tail = this.failed ? '' : text.slice(at);
      if (
        this.state.tail.length > MAX_EVENT_CHARACTERS ||
        jsonTextBytes(this.state.tail) > MAX_EVENT_CHARACTERS
      )
        this.fail('应用流事件超过解析缓冲大小。');
    } catch {
      this.fail('回答数据格式无效。已保存部分内容，请主动重新生成。');
    }
  }
  end() {}
  assertEnded() {
    if (this.failed) throw new StreamParseError(this.state.failure!);
    if (this.state.utf8 || this.state.tail || !this.state.done)
      throw new StreamParseError(
        '与模型供应商的连接提前结束或未正常完成回答。已保存部分内容，请主动重新生成。',
      );
  }
  assertComplete() {
    this.assertEnded();
    if (!['stop', 'length'].includes(this.state.finishReason ?? ''))
      throw new StreamParseError(
        this.state.finishMessage ??
          `模型供应商未正常完成回答${this.state.rawFinishReason ? `（${this.state.rawFinishReason}）` : ''}。已保存部分内容。`,
      );
    if (!this.content) throw new StreamParseError('模型供应商未返回文字回答。');
  }
  private fail(message: string) {
    this.state.failure ??= message;
    this.state.tail = '';
    this.state.utf8 = '';
  }
  private event(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || this.state.done)
      throw new Error('Invalid application event');
    const event = value as GenerationEvent;
    this.state.started = true;
    if (event.type === 'text' || event.type === 'reasoning') {
      if (typeof event.text !== 'string' || (event.replace !== undefined && event.replace !== true))
        throw new Error('Invalid text event');
      if (!event.text && !event.replace) return;
      const kind = event.type === 'text' ? 'content' : 'reasoning';
      if (kind === 'reasoning' && !this.state.showReasoning) return;
      const before = this[kind],
        next = event.replace ? event.text : before + event.text;
      const budget =
        MAX_MESSAGE_TEXT_BYTES - (kind === 'content' ? this.reasoningBytes : this.contentBytes);
      // Only replacements encode the entire channel; appends count the new suffix.
      const joinsPair =
        !event.replace && /^[\uDC00-\uDFFF]/.test(event.text) && /[\uD800-\uDBFF]$/.test(before);
      const needed = event.replace
        ? jsonTextBytes(next)
        : (kind === 'content' ? this.contentBytes : this.reasoningBytes) +
          jsonTextBytes(event.text) -
          (joinsPair ? 8 : 0);
      const accepted = needed <= budget ? next : textWithinBytes(next, budget);
      this[kind] = accepted;
      const size = needed <= budget ? needed : jsonTextBytes(accepted);
      if (kind === 'content') {
        this.contentBytes = size;
        this.state.textDeltas++;
      } else {
        this.reasoningBytes = size;
        this.state.reasoningDeltas++;
      }
      if (event.replace) this.deltas.push({ kind, text: accepted, replace: true });
      else if (accepted.length > before.length)
        this.deltas.push({ kind, text: accepted.slice(before.length) });
      if (accepted.length !== next.length) this.fail(MESSAGE_TEXT_LIMIT_MESSAGE);
    } else if (event.type === 'usage' || event.type === 'finish') {
      if (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage))
        throw new Error('Invalid usage');
      for (const [key, count] of Object.entries(event.usage)) {
        if (!usageKeys.has(key as keyof StreamUsage) || !Number.isSafeInteger(count) || count < 0)
          throw new Error('Invalid usage count');
        this.state.usage[key as keyof StreamUsage] = count;
      }
      if (event.type === 'finish') {
        if (
          !FINISH_REASONS.includes(event.reason) ||
          typeof event.usageIsFinal !== 'boolean' ||
          (event.rawReason !== undefined &&
            (typeof event.rawReason !== 'string' || event.rawReason.length > 128)) ||
          (event.message !== undefined &&
            (typeof event.message !== 'string' || event.message.length > 4096))
        )
          throw new Error('Invalid finish');
        this.state.done = true;
        this.state.finishReason = event.reason;
        this.state.rawFinishReason = event.rawReason;
        this.state.finishMessage = event.message;
        this.state.usageIsFinal = event.usageIsFinal;
      }
    } else throw new Error('Unknown application event');
  }
}
