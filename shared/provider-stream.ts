import { createParser, type EventSourceParser } from 'eventsource-parser';
import type { ProviderKind } from './types';

export const MAX_EVENT_CHARACTERS = 256 * 1024;
const LIMIT = 100_000;
export interface StreamUsage {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
  uncachedInputTokens?: number; textOutputTokens?: number; toolInputTokens?: number;
}
export interface StreamState {
  protocol: ProviderKind; showReasoning: boolean; tail: string; utf8: string; started: boolean;
  done: boolean; finishReason?: 'stop' | 'length' | 'other'; failure?: string;
  textDeltas: number; reasoningDeltas: number; usage: StreamUsage; usageIsFinal: boolean;
  promptInputTokens?: number;
  thoughts: { id: string; raw: string; summary: string }[];
}
export type ParsedDelta = { kind: 'content' | 'reasoning'; text: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export const encodeBytes = (bytes: Uint8Array): string => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
};
export const decodeBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export class StreamParseError extends Error {}

// This checkpoint records only the incomplete SSE frame and protocol state, not the whole wire log.
// Both browser previews and server snapshot/final replay use this exact decoder.
export class ProviderStream {
  content: string;
  reasoning: string;
  private state: StreamState;
  private readonly parser: EventSourceParser;
  private deltas: ParsedDelta[] = [];
  constructor(protocol: ProviderKind, showReasoning: boolean, checkpoint?: StreamState, content = '', reasoning = '',
    private readonly observeEvent?: (event: Readonly<Record<string, unknown>>) => void) {
    this.content = content; this.reasoning = reasoning;
    this.state = checkpoint ? structuredClone(checkpoint) : {
      protocol, showReasoning, tail: '', utf8: '', started: false, done: false, textDeltas: 0, reasoningDeltas: 0, usage: {}, usageIsFinal: false, thoughts: [],
    };
    if (this.state.protocol !== protocol || this.state.showReasoning !== showReasoning) throw new StreamParseError('流协议状态不一致。');
    this.parser = createParser({ maxBufferSize: MAX_EVENT_CHARACTERS,
      onEvent: (event) => this.event(event.data),
      onError: (error) => { if (error.type === 'max-buffer-size-exceeded') this.fail('供应商流事件超过原型限制。'); },
    });
    if (this.state.tail) this.parser.feed(this.state.tail);
  }
  checkpoint(): StreamState { return structuredClone(this.state); }
  get failed() { return Boolean(this.state.failure); }
  drainDeltas(): ParsedDelta[] { const deltas = this.deltas; this.deltas = []; return deltas; }
  feed(bytes: Uint8Array) {
    if (this.state.failure) return;
    try {
      const pending = decodeBytes(this.state.utf8), input = new Uint8Array(pending.length + bytes.length);
      input.set(pending); input.set(bytes, pending.length);
      let cut = input.length, start = input.length - 1;
      while (start >= 0 && (input[start] & 0xc0) === 0x80) start--;
      if (start >= 0) {
        const lead = input[start], expected = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
        if (input.length - start < expected) cut = start;
      }
      let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.subarray(0, cut));
      this.state.utf8 = encodeBytes(input.subarray(cut));
      if (!text) return;
      if (!this.state.started) { this.state.started = true; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
      this.parser.feed(text);
      if (this.state.failure) return;
      this.state.tail = this.unfinishedTail(this.state.tail + text);
      if (this.state.tail.length > MAX_EVENT_CHARACTERS) this.fail('供应商流事件超过原型限制。');
    } catch { this.fail('供应商流格式无效。已保存部分内容，请主动重新生成。'); }
  }
  end() {
    // At EOF a pending CR is a complete line ending. Resolve it without inventing an extra blank line.
    if (this.state.tail.endsWith('\r') && !this.state.utf8) this.feed(new Uint8Array([10]));
  }
  assertEnded() {
    this.end();
    if (this.state.failure) throw new StreamParseError(this.state.failure);
    if (this.state.utf8 || this.state.tail.split(/\r\n|\r|\n/).some((line) => line.trim() && !line.startsWith(':')) || !this.state.done) {
      throw new StreamParseError('与模型供应商的连接提前结束或未正常完成回答。已保存部分内容，请主动重新生成。');
    }
  }
  assertComplete() {
    this.assertEnded();
    if (!['stop', 'length'].includes(this.state.finishReason ?? '')) throw new StreamParseError('与模型供应商的连接提前结束或未正常完成回答。已保存部分内容，请主动重新生成。');
    if (!this.content) throw new StreamParseError('模型供应商未返回文字回答。');
  }
  private unfinishedTail(text: string) {
    // Track the last blank-line boundary so the library's partial-line/event state can be restored.
    // A trailing CR remains pending until the next character, matching eventsource-parser.
    let lineStart = 0, boundary = 0;
    const endings = /\r\n|\r|\n/g;
    for (let match = endings.exec(text); match; match = endings.exec(text)) {
      if (match[0] === '\r' && match.index === text.length - 1) break;
      const end = match.index + match[0].length;
      if (match.index === lineStart) boundary = end;
      lineStart = end;
    }
    return text.slice(boundary);
  }
  private fail(message: string) { this.state.failure ??= message; this.state.tail = ''; this.state.utf8 = ''; }
  private append(kind: 'content' | 'reasoning', value: unknown) {
    if (this.state.failure) return;
    const text = string(value);
    if (!text) return;
    if (kind === 'reasoning' && !this.state.showReasoning) return;
    this.state[kind === 'content' ? 'textDeltas' : 'reasoningDeltas']++;
    let accepted = text.slice(0, Math.max(0, LIMIT - this[kind].length));
    if (accepted.length < text.length && /[\uD800-\uDBFF]$/.test(accepted) && /[\uDC00-\uDFFF]/.test(text[accepted.length])) accepted = accepted.slice(0, -1);
    this[kind] += accepted;
    if (accepted) this.deltas.push({ kind, text: accepted });
    if (accepted.length !== text.length) this.fail(kind === 'content' ? '回答已达到 100,000 字的原型限制。' : '思考内容已达到 100,000 字的原型限制。');
  }
  private usage(value: unknown, kind: ProviderKind) {
    const usage = object(value), inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details), outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details);
    const next: StreamUsage = kind === 'gemini' ? {
      textOutputTokens: number(usage.candidatesTokenCount), totalTokens: number(usage.totalTokenCount),
      cachedInputTokens: number(usage.cachedContentTokenCount), reasoningTokens: number(usage.thoughtsTokenCount), toolInputTokens: number(usage.toolUsePromptTokenCount),
    } : kind === 'anthropic' ? {
      uncachedInputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
      cachedInputTokens: number(usage.cache_read_input_tokens), cacheWriteInputTokens: number(usage.cache_creation_input_tokens),
      reasoningTokens: number(outputDetails.thinking_tokens),
    } : {
      inputTokens: number(usage.input_tokens) ?? number(usage.prompt_tokens), outputTokens: number(usage.output_tokens) ?? number(usage.completion_tokens), totalTokens: number(usage.total_tokens),
      cachedInputTokens: number(inputDetails.cached_tokens) ?? number(usage.prompt_cache_hit_tokens),
      cacheWriteInputTokens: number(inputDetails.cache_write_tokens), reasoningTokens: number(outputDetails.reasoning_tokens),
    };
    for (const [key, value] of Object.entries(next)) if (value !== undefined) this.state.usage[key as keyof StreamUsage] = value;
    const report = this.state.usage;
    if (kind === 'anthropic' && report.uncachedInputTokens !== undefined) {
      report.inputTokens = number(report.uncachedInputTokens + (report.cachedInputTokens ?? 0) + (report.cacheWriteInputTokens ?? 0));
    }
    if (kind === 'gemini') {
      // These API counters are disjoint. Keep the reported total; never invent one.
      this.state.promptInputTokens = number(usage.promptTokenCount) ?? this.state.promptInputTokens;
      if (this.state.promptInputTokens !== undefined) report.inputTokens = number(this.state.promptInputTokens + (report.toolInputTokens ?? 0));
      if (report.textOutputTokens !== undefined) report.outputTokens = number(report.textOutputTokens + (report.reasoningTokens ?? 0));
    }
    return Object.values(next).some((value) => value !== undefined);
  }
  private finish(reason: unknown, accepted: string[], length: string[]) {
    const value = string(reason);
    this.state.finishReason = accepted.includes(value) ? 'stop' : length.includes(value) ? 'length' : 'other';
  }
  private event(data: string) {
    if (this.state.failure) return;
    if (data.length > MAX_EVENT_CHARACTERS) { this.fail('供应商流事件超过原型限制。'); return; }
    if (data === '[DONE]') { if (this.state.protocol === 'openai-chat') this.state.done = true; return; }
    try {
      const event = object(JSON.parse(data)), kind = this.state.protocol;
      this.observeEvent?.(event);
      if (event.error || event.type === 'error' || event.type === 'response.failed') {
        this.fail('模型供应商在生成期间返回错误。已保存部分内容。'); return;
      }
      if (kind === 'openai-chat') {
        const reported = this.usage(event.usage, kind), choices = array(event.choices);
        if (reported && (choices.length === 0 || choices.some((value) => object(value).finish_reason != null))) this.state.usageIsFinal = true;
        for (const value of choices) {
          const choice = object(value);
          if (choice.index !== undefined && choice.index !== 0) continue;
          const delta = object(choice.delta);
          this.append('reasoning', delta.reasoning_content ?? delta.reasoning);
          this.append('content', delta.content);
          if (choice.finish_reason != null) this.finish(choice.finish_reason, ['stop'], ['length']);
        }
      } else if (kind === 'openai-responses') {
        const type = string(event.type);
        if (type === 'response.output_text.delta') this.append('content', event.delta);
        if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') this.responseThought(event, type === 'response.reasoning_text.delta' ? 'raw' : 'summary');
        if (type === 'response.completed' || type === 'response.incomplete') {
          const response = object(event.response);
          this.state.usageIsFinal = this.usage(response.usage, kind);
          this.finish(type === 'response.completed' ? 'stop' : object(response.incomplete_details).reason, ['stop'], ['max_output_tokens']);
          this.state.done = true;
        }
      } else if (kind === 'anthropic') {
        const type = string(event.type), delta = object(event.delta);
        if (type === 'message_start') this.usage(object(event.message).usage, kind);
        if (type === 'content_block_start') {
          const block = object(event.content_block);
          if (block.type === 'text') this.append('content', block.text);
          if (block.type === 'thinking') this.append('reasoning', block.thinking);
        }
        if (type === 'content_block_delta') {
          if (delta.type === 'text_delta') this.append('content', delta.text);
          if (delta.type === 'thinking_delta') this.append('reasoning', delta.thinking);
        }
        if (type === 'message_delta') {
          this.usage(event.usage, kind);
          if (delta.stop_reason != null) this.finish(delta.stop_reason, ['end_turn', 'stop_sequence'], ['max_tokens']);
          if (this.state.finishReason && number(object(event.usage).output_tokens) !== undefined) this.state.usageIsFinal = true;
        }
        if (type === 'message_stop') this.state.done = true;
      } else if (kind === 'gemini') {
        const reported = this.usage(event.usageMetadata, kind);
        if (object(event.promptFeedback).blockReason) this.fail('模型供应商未正常完成回答。已保存部分内容，请主动重新生成。');
        for (const value of array(event.candidates)) {
          const candidate = object(value);
          if (candidate.index !== undefined && candidate.index !== 0) continue;
          for (const part of array(object(candidate.content).parts)) {
            const value = object(part); this.append(value.thought === true ? 'reasoning' : 'content', value.text);
          }
          if (candidate.finishReason) { this.finish(candidate.finishReason, ['STOP'], ['MAX_TOKENS']); this.state.done = true; }
        }
        if (reported && this.state.done) this.state.usageIsFinal = true;
      }
    } catch { this.fail('供应商流格式无效。已保存部分内容，请主动重新生成。'); }
  }
  private responseThought(event: Record<string, unknown>, channel: 'raw' | 'summary') {
    if (!this.state.showReasoning) return;
    if (string(event.item_id).length > 200) { this.fail('思考片段标识超过原型限制。'); return; }
    const id = `${string(event.item_id)}:${number(event.content_index ?? event.summary_index) ?? 0}`;
    let part = this.state.thoughts.find((part) => part.id === id);
    if (!part) {
      if (this.state.thoughts.length >= 64) { this.fail('思考片段超过原型限制。'); return; }
      part = { id, raw: '', summary: '' }; this.state.thoughts.push(part);
    }
    const delta = string(event.delta);
    if (!delta) return;
    if (channel === 'summary' && part.raw) return;
    const previous = this.reasoning;
    if (channel === 'raw') part.summary = '';
    part[channel] += delta;
    this.state.reasoningDeltas++;
    const next = this.state.thoughts.map((part) => part.raw || part.summary).join('');
    this.reasoning = next.slice(0, LIMIT);
    if (next.length > LIMIT && /[\uD800-\uDBFF]$/.test(this.reasoning) && /[\uDC00-\uDFFF]/.test(next[LIMIT])) this.reasoning = this.reasoning.slice(0, -1);
    if (next.length > LIMIT) this.fail('思考内容已达到 100,000 字的原型限制。');
    // Consumers that append deltas only are used for supplier tests; the UI uses the full decoded view.
    if (this.reasoning.startsWith(previous)) this.deltas.push({ kind: 'reasoning', text: this.reasoning.slice(previous.length) });
  }
}
