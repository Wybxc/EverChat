import { toolDefinitions as webToolDefinitions } from '../../shared/tools/definitions';
export { toolDefinitions as webToolDefinitions } from '../../shared/tools/definitions';
import type { ModelMessage, TypedToolCall, ToolSet } from 'ai';
import {
  MAX_MESSAGE_TEXT_BYTES,
  MAX_SQL_PAYLOAD_BYTES,
  jsonTextBytes,
} from '../../shared/conversation/limits';
import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ReasoningPart,
  LanguageModelV4TextPart,
  LanguageModelV4ToolCallPart,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { type StreamUsage } from '../../shared/streaming/provider-stream';
import type { ProviderConfig } from '../../shared/providers/types';
import {
  assertWebToolSupport,
  webToolInputSchemas,
  MAX_TOOL_INPUT_BYTES,
  validateWebToolCall,
  validateWebToolCandidate,
  validateWebToolIdentity,
  validateWebToolOutcome,
  type WebToolCandidate,
  type WebToolName,
  type WebToolOutcome,
} from '../../shared/tools/tasks';
import { ProviderError } from '../generation/errors';

const MAX_TOOL_TURN_CONTEXT_BYTES = MAX_SQL_PAYLOAD_BYTES;
type AssistantPart =
  LanguageModelV4TextPart | LanguageModelV4ReasoningPart | LanguageModelV4ToolCallPart;
// This private continuation never enters messages, snapshots, exports or client caches.
export interface ProviderToolTurn {
  identity: string;
  content: AssistantPart[];
  calls: WebToolCandidate[];
  finishReason: 'stop' | 'length' | 'tool-calls';
  usage: StreamUsage;
  usageIsFinal: boolean;
}
export interface ProviderToolExchange {
  turn: ProviderToolTurn;
  outcomes: WebToolOutcome[];
}
export interface ProviderToolRequest {
  enabled: readonly WebToolName[];
  exchanges?: ProviderToolExchange[];
  toolChoice?: 'auto' | 'none';
}
export const providerToolIdentity = (config: ProviderConfig) =>
  JSON.stringify([config.provider, config.baseUrl, config.model]);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
// Match Core's response-message policy for malformed primitive arguments while
// retaining the original parsed/raw input in the rejected candidate.
const continuationInput = (call: WebToolCandidate) =>
  call.invalid && (!call.input || typeof call.input !== 'object' || Array.isArray(call.input))
    ? {}
    : call.input;

// Some SDKs synthesize missing or duplicate call IDs. Reject ambiguous wire IDs
// before decoding so a saved result cannot accidentally answer a different call.
function toolWireIdentity(config: ProviderConfig) {
  const ids = new Set<string>(),
    slots = new Map<string, { id: string; name: string }>();
  const add = (slot: string, value: unknown, name: unknown, partial = false) => {
    const previous = slots.get(slot);
    if (
      previous &&
      partial &&
      (value === undefined || value === previous.id) &&
      (name === undefined || name === previous.name)
    )
      return;
    if (previous || typeof value !== 'string' || typeof name !== 'string' || ids.has(value))
      throw new Error('工具调用标识重复或缺失。');
    validateWebToolIdentity(value, name);
    ids.add(value);
    slots.set(slot, { id: value, name });
  };
  return {
    observe(event: Readonly<Record<string, unknown>>) {
      if (config.provider === 'openai-chat') {
        for (const value of array(event.choices)) {
          const choice = object(value);
          if (choice.index !== undefined && choice.index !== 0) continue;
          for (const value of array(object(choice.delta).tool_calls)) {
            const call = object(value),
              fn = object(call.function);
            if (!Number.isInteger(call.index) || Number(call.index) < 0)
              throw new Error('工具调用缺少索引。');
            add(String(call.index), call.id, fn.name, true);
          }
        }
      } else if (
        config.provider === 'openai-responses' &&
        event.type === 'response.output_item.added'
      ) {
        const call = object(event.item);
        if (call.type === 'function_call') add(String(event.output_index), call.call_id, call.name);
      } else if (config.provider === 'anthropic' && event.type === 'content_block_start') {
        const call = object(event.content_block);
        if (call.type === 'tool_use') add(String(event.index), call.id, call.name);
      } else if (config.provider === 'gemini') {
        for (const value of array(event.candidates)) {
          const candidate = object(value);
          if (candidate.index !== undefined && candidate.index !== 0) continue;
          for (const value of array(object(candidate.content).parts)) {
            const call = object(object(value).functionCall);
            if (call.id !== undefined) add(String(slots.size), call.id, call.name);
          }
        }
      }
    },
    assertCalls(calls: WebToolCandidate[]) {
      if (
        (config.provider !== 'gemini' && ids.size !== calls.length) ||
        [...ids].some((id) => !calls.some((call) => call.id === id))
      )
        throw new ProviderError('供应商工具调用标识与原始响应不符。');
    },
  };
}

/** Stop requesting a broken service or repeating the same failed action without progress. */
export function toolContinuationChoice(exchanges: ProviderToolExchange[]): 'auto' | 'none' {
  if (
    exchanges.some((exchange) =>
      exchange.outcomes.some((outcome) => outcome.status === 'failed' && outcome.failure?.terminal),
    )
  )
    return 'none';
  const last = exchanges.at(-1),
    previous = exchanges.at(-2);
  if (!last || !previous) return 'auto';
  const fingerprints = ({ turn, outcomes }: ProviderToolExchange) => {
    if (outcomes.some((outcome) => outcome.status === 'completed' && outcome.sources.length))
      return [];
    return turn.calls
      .filter((call) =>
        outcomes.some((outcome) => outcome.id === call.id && outcome.status === 'failed'),
      )
      .map((call) => {
        const input =
          call.input && typeof call.input === 'object' && !Array.isArray(call.input)
            ? Object.fromEntries(Object.entries(call.input).sort(([a], [b]) => a.localeCompare(b)))
            : call.input;
        return JSON.stringify([call.name, input]);
      });
  };
  const before = fingerprints(previous);
  return fingerprints(last).some((fingerprint) => before.includes(fingerprint)) ? 'none' : 'auto';
}

function mergeMetadata(
  part: AssistantPart,
  metadata: SharedV4ProviderMetadata | undefined,
  signatureDelta = false,
) {
  if (!metadata) return;
  const merged: SharedV4ProviderOptions = { ...part.providerOptions };
  for (const [namespace, value] of Object.entries(metadata)) {
    const previous = merged[namespace] ?? {};
    merged[namespace] = { ...previous, ...value };
    if (
      signatureDelta &&
      namespace === 'anthropic' &&
      typeof value.signature === 'string' &&
      typeof previous.signature === 'string'
    ) {
      merged[namespace].signature = previous.signature + value.signature;
    }
  }
  part.providerOptions = merged;
}

function assertPrivateReasoning(config: ProviderConfig, content: AssistantPart[]) {
  const present = (value: unknown) => typeof value === 'string' && value.length > 0;
  for (const part of content)
    if (part.type === 'reasoning') {
      const options = part.providerOptions;
      if (
        (config.provider === 'anthropic' &&
          !present(options?.anthropic?.signature) &&
          !present(options?.anthropic?.redactedData)) ||
        (config.provider === 'openai-responses' &&
          !Object.values(options ?? {}).some(
            (value) =>
              present(value.reasoningEncryptedContent) ||
              (Array.isArray(value.reasoningContent) && value.reasoningContent.length > 0),
          ))
      )
        throw new ProviderError('供应商未返回工具续接需要的完整推理资料。');
    }
}

export function validateProviderToolTurn(
  turn: ProviderToolTurn,
  enabled: readonly WebToolName[],
  config: ProviderConfig,
) {
  if (
    turn.identity !== providerToolIdentity(config) ||
    !Array.isArray(turn.content) ||
    !turn.content.length ||
    !Array.isArray(turn.calls) ||
    bytes(turn) > MAX_TOOL_TURN_CONTEXT_BYTES ||
    !['stop', 'length', 'tool-calls'].includes(turn.finishReason) ||
    turn.calls.length > 0 !== (turn.finishReason === 'tool-calls')
  )
    throw new ProviderError('工具续接状态与原调用不符。');
  let text = 0,
    reasoning = 0;
  for (const part of turn.content) {
    if (part.type === 'text' && typeof part.text === 'string') text += jsonTextBytes(part.text);
    else if (part.type === 'reasoning' && typeof part.text === 'string')
      reasoning += jsonTextBytes(part.text);
    else if (part.type !== 'tool-call') throw new ProviderError('工具续接内容类型无效。');
  }
  if (
    text + reasoning > MAX_MESSAGE_TEXT_BYTES ||
    (!turn.calls.length && !turn.content.some((part) => part.type === 'text' && part.text.trim()))
  )
    throw new ProviderError('工具续接正文或思考内容无效。');
  const actual = turn.content.filter((part) => part.type === 'tool-call'),
    used = new Set<string>();
  if (actual.length !== turn.calls.length) throw new ProviderError('工具续接调用数量不符。');
  for (const candidate of turn.calls) {
    const call = validateWebToolCandidate(candidate, enabled),
      matches = actual.filter((part) => part.toolCallId === call.id);
    if (
      used.has(call.id) ||
      matches.length !== 1 ||
      matches[0].providerExecuted ||
      matches[0].toolName !== call.name ||
      JSON.stringify(matches[0].input) !== JSON.stringify(continuationInput(call))
    )
      throw new ProviderError('工具续接调用身份或参数不符。');
    used.add(call.id);
  }
  if (turn.calls.length) assertPrivateReasoning(config, turn.content);
}

/** Collects private continuation parts during the single live SDK parse. */
export class ProviderToolCollector {
  private readonly content: AssistantPart[] = [];
  private readonly calls: WebToolCandidate[] = [];
  private readonly blocks = new Map<
    string,
    LanguageModelV4TextPart | LanguageModelV4ReasoningPart
  >();
  private readonly toolBlocks = new Map<
    string,
    {
      part: LanguageModelV4ToolCallPart;
      inputBytes: number;
      rawComplete: boolean;
      complete: boolean;
    }
  >();
  private finishReason: ProviderToolTurn['finishReason'] | undefined;
  private textCharacters = 0;
  private reasoningCharacters = 0;
  private readonly wireIdentity;
  constructor(
    private readonly config: ProviderConfig,
    private readonly enabled: readonly WebToolName[],
  ) {
    assertWebToolSupport(config.modelMetadata, enabled);
    this.wireIdentity = toolWireIdentity(config);
  }
  add(part: LanguageModelV4StreamPart) {
    const { content, blocks, toolBlocks, wireIdentity } = this;
    if (part.type === 'raw') {
      wireIdentity.observe(object(part.rawValue));
      return;
    }
    const add = (part: AssistantPart) => {
      content.push(part);
    };
    const toolBlock = (id: string, name: string) => {
      let block = toolBlocks.get(id);
      if (!block) {
        validateWebToolIdentity(id, name);
        const part: LanguageModelV4ToolCallPart = {
          type: 'tool-call',
          toolCallId: id,
          toolName: name,
          input: {},
        };
        block = { part, inputBytes: 0, rawComplete: false, complete: false };
        toolBlocks.set(id, block);
        add(part);
      }
      if (block.part.toolName !== name) throw new ProviderError('同一工具调用的名称发生变化。');
      return block;
    };
    if (part.type === 'error') throw new ProviderError('供应商无法完成工具轮次。');
    if (part.type === 'text-start' || part.type === 'reasoning-start') {
      const type = part.type === 'text-start' ? 'text' : 'reasoning',
        key = `${type}:${part.id}`;
      if (blocks.has(key)) throw new ProviderError('供应商重复开始同一内容部分。');
      const block: LanguageModelV4TextPart | LanguageModelV4ReasoningPart = { type, text: '' };
      mergeMetadata(block, part.providerMetadata);
      blocks.set(key, block);
      add(block);
    } else if (
      part.type === 'text-delta' ||
      part.type === 'reasoning-delta' ||
      part.type === 'text-end' ||
      part.type === 'reasoning-end'
    ) {
      const reasoning = part.type.startsWith('reasoning'),
        block = blocks.get(`${reasoning ? 'reasoning' : 'text'}:${part.id}`);
      if (!block) throw new ProviderError('供应商内容部分缺少起始状态。');
      if ('delta' in part) {
        const joinsPair =
          /^[\uDC00-\uDFFF]/.test(part.delta) && /[\uD800-\uDBFF]$/.test(block.text);
        const deltaBytes = jsonTextBytes(part.delta) - (joinsPair ? 8 : 0);
        if (reasoning) this.reasoningCharacters += deltaBytes;
        else this.textCharacters += deltaBytes;
        if (this.textCharacters + this.reasoningCharacters > MAX_MESSAGE_TEXT_BYTES)
          throw new ProviderError('工具轮次的正文或思考内容超过限制。');
        block.text += part.delta;
      }
      mergeMetadata(block, part.providerMetadata, part.type === 'reasoning-delta');
      if (part.type.endsWith('-end'))
        blocks.delete(`${reasoning ? 'reasoning' : 'text'}:${part.id}`);
    } else if (part.type === 'tool-input-start') {
      if (part.providerExecuted || part.dynamic || toolBlocks.has(part.id))
        throw new ProviderError('供应商返回了不允许的工具调用。');
      mergeMetadata(toolBlock(part.id, part.toolName).part, part.providerMetadata);
    } else if (part.type === 'tool-input-delta') {
      const block = toolBlocks.get(part.id);
      if (
        !block ||
        block.complete ||
        (block.inputBytes += new TextEncoder().encode(part.delta).byteLength) > MAX_TOOL_INPUT_BYTES
      )
        throw new ProviderError('工具参数缺少起始状态或超过大小限制。');
      mergeMetadata(block.part, part.providerMetadata);
    } else if (part.type === 'tool-input-end') {
      const block = toolBlocks.get(part.id);
      if (block) mergeMetadata(block.part, part.providerMetadata);
    } else if (part.type === 'tool-call') {
      if (
        part.providerExecuted ||
        part.dynamic ||
        new TextEncoder().encode(part.input).byteLength > MAX_TOOL_INPUT_BYTES
      )
        throw new ProviderError('供应商返回了不允许的工具调用。');
      const block = toolBlock(part.toolCallId, part.toolName);
      if (block.rawComplete) throw new ProviderError('供应商重复返回同一工具调用。');
      mergeMetadata(block.part, part.providerMetadata);
      block.rawComplete = true;
    } else if (part.type === 'finish') {
      if (
        this.finishReason ||
        !['stop', 'length', 'tool-calls'].includes(part.finishReason.unified)
      )
        throw new ProviderError('供应商未正常完成工具轮次。');
      this.finishReason = part.finishReason.unified as ProviderToolTurn['finishReason'];
    } else if (
      !(part.type === 'custom' && part.kind === 'anthropic.message_start') &&
      !['stream-start', 'response-metadata'].includes(part.type)
    ) {
      throw new ProviderError('供应商返回了当前不支持的内容或执行权限。');
    }
    if (
      'providerMetadata' in part &&
      part.providerMetadata &&
      bytes(content) > MAX_TOOL_TURN_CONTEXT_BYTES
    )
      throw new ProviderError('工具续接内容超过保存限制。');
  }
  acceptCall(part: TypedToolCall<ToolSet>) {
    const block = this.toolBlocks.get(part.toolCallId);
    if (
      !block ||
      !block.rawComplete ||
      block.complete ||
      block.part.toolName !== part.toolName ||
      part.providerExecuted
    )
      throw new ProviderError('Core 工具调用与原始响应身份不符。');
    let call: WebToolCandidate;
    const input = part.input ?? null;
    if (this.config.apiKey && JSON.stringify(input).includes(this.config.apiKey))
      throw new ProviderError('工具参数包含不可公开的供应商凭据。');
    try {
      if (part.invalid) throw new Error();
      call = validateWebToolCall({ id: part.toolCallId, name: part.toolName, input }, this.enabled);
    } catch {
      const known = this.enabled.includes(part.toolName as WebToolName);
      call = validateWebToolCandidate(
        {
          id: part.toolCallId,
          name: part.toolName,
          input,
          invalid: true,
          error: known
            ? part.toolName === 'web_search'
              ? `web_search 仅允许 query 参数：非空字符串，最多 ${this.config.webTools?.provider === 'deepseek' ? '128 个 Unicode 字符' : '500 个字符'}。请修正参数后再调用。`
              : 'read_webpage.url 必须是公开 HTTP 或 HTTPS 地址，最多 8192 个字符，不含凭据或自定义端口。请尝试有效来源。'
            : '该工具未启用。请只使用本轮提供的工具。',
        },
        this.enabled,
      );
    }
    block.part.input = continuationInput(call);
    block.complete = true;
    this.calls.push(call);
  }
  finish(usage: StreamUsage, usageIsFinal: boolean): ProviderToolTurn {
    const { content, calls, blocks, toolBlocks, finishReason, config, enabled, wireIdentity } =
      this;
    if (
      !finishReason ||
      blocks.size ||
      [...toolBlocks.values()].some((block) => !block.complete) ||
      calls.length > 0 !== (finishReason === 'tool-calls') ||
      (!calls.length && !content.some((part) => part.type === 'text' && part.text.trim()))
    )
      throw new ProviderError('供应商未完整返回工具调用或文字回答。');
    if (calls.length) assertPrivateReasoning(config, content);
    wireIdentity.assertCalls(calls);
    const turn: ProviderToolTurn = {
      identity: providerToolIdentity(config),
      content,
      calls,
      finishReason,
      usage,
      usageIsFinal,
    };
    if (bytes(turn) > MAX_TOOL_TURN_CONTEXT_BYTES)
      throw new ProviderError('工具续接内容超过保存限制。');
    validateProviderToolTurn(turn, enabled, config);
    return turn;
  }
}

export function providerToolPrompt(
  exchanges: ProviderToolExchange[],
  enabled: readonly WebToolName[],
  config: ProviderConfig,
): ModelMessage[] {
  const prompt: ModelMessage[] = [],
    used = new Set<string>();
  try {
    for (const { turn, outcomes } of exchanges) {
      validateProviderToolTurn(turn, enabled, config);
      if (turn.finishReason !== 'tool-calls' || outcomes.length !== turn.calls.length)
        throw new Error();
      const actual = turn.content.filter((part) => part.type === 'tool-call');
      const results = turn.calls.map((candidate) => {
        const call = validateWebToolCandidate(candidate, enabled),
          matching = actual.find((part) => part.toolCallId === call.id);
        if (
          used.has(call.id) ||
          !matching ||
          matching.providerExecuted ||
          matching.toolName !== call.name ||
          JSON.stringify(matching.input) !== JSON.stringify(continuationInput(call))
        )
          throw new Error();
        used.add(call.id);
        const matches = outcomes.filter((outcome) => outcome.id === call.id);
        if (matches.length !== 1) throw new Error();
        const outcome = validateWebToolOutcome(matches[0]);
        if (outcome.name !== call.name) throw new Error();
        return {
          type: 'tool-result' as const,
          toolCallId: call.id,
          toolName: call.name,
          output:
            outcome.status === 'completed'
              ? {
                  type: 'json' as const,
                  value: {
                    sources: outcome.sources,
                    ...(outcome.attachment ? { attachment: outcome.attachment } : {}),
                    ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
                  },
                }
              : { type: 'error-text' as const, value: outcome.error },
        };
      });
      prompt.push({ role: 'assistant', content: turn.content }, { role: 'tool', content: results });
    }
  } catch {
    throw new ProviderError('工具续接状态或结果与原调用不符。');
  }
  return prompt;
}
