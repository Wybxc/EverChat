import type { ProviderConfig } from '../../shared/providers/types';
import { ProviderError } from '../generation/errors';

type Block = Record<string, unknown>;
const object = (value: unknown): Block =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Block) : {};
const blocks = (value: unknown): Block[] => (Array.isArray(value) ? value : []);
const maxReplayBytes = 384 * 1024;
const allowedResponsesItems = new Set([
  'message',
  'reasoning',
  'function_call',
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
]);
const allowedAnthropicBlocks = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
]);
const invalid = () => new ProviderError('供应商没有提供完整的服务端工具续接资料。');

export type ServerToolReplay =
  | { type: 'anthropic'; blocks: Block[]; container?: string }
  | { type: 'responses'; blocks: Block[] }
  | { type: 'deepseek-chat'; blocks: Block[] };

export function validateServerToolReplay(
  replay: ServerToolReplay,
  config: ProviderConfig,
  calls: readonly { id: string }[],
) {
  const validType =
    (replay.type === 'anthropic' && config.provider === 'anthropic') ||
    (replay.type === 'responses' && config.provider === 'openai-responses') ||
    (replay.type === 'deepseek-chat' &&
      config.provider === 'openai-chat' &&
      config.serverTools?.[0]?.vendor === 'deepseek');
  if (
    !config.serverTools?.length ||
    !validType ||
    !Array.isArray(replay.blocks) ||
    !replay.blocks.length ||
    replay.blocks.length > 96 ||
    Buffer.byteLength(JSON.stringify(replay)) > maxReplayBytes
  )
    throw invalid();
  if (replay.type === 'deepseek-chat') return;
  const anthropic = replay.type === 'anthropic';
  const types = anthropic ? allowedAnthropicBlocks : allowedResponsesItems;
  if (replay.blocks.some((part) => !types.has(String(part?.type)))) throw invalid();
  const ids = replay.blocks.flatMap((part) =>
    part.type === (anthropic ? 'tool_use' : 'function_call')
      ? [part.id && anthropic ? part.id : part.call_id]
      : [],
  );
  if (ids.length !== calls.length || calls.some(({ id }) => !ids.includes(id))) throw invalid();
  if (
    anthropic &&
    replay.container !== undefined &&
    (typeof replay.container !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(replay.container))
  )
    throw invalid();
}

/** Exact wire blocks are retained only in a private, bounded continuation. */
export class ServerToolReplayCollector {
  private readonly parts = new Map<number, { block: Block; open: boolean; json: string }>();
  private chat: Block[] = [];
  private container?: string;
  private hosted = false;
  private invalid = false;
  private bytes = 0;
  constructor(private readonly config: ProviderConfig) {}

  observe(raw: Block) {
    if (this.invalid) return;
    if (this.config.provider === 'anthropic') {
      this.anthropic(raw);
    } else if (
      this.config.provider === 'openai-responses' &&
      raw.type === 'response.output_item.done'
    ) {
      const item = object(raw.item);
      this.hosted ||= [
        'web_search_call',
        'file_search_call',
        'code_interpreter_call',
        'shell_call',
        'shell_call_output',
        'image_generation_call',
      ].includes(String(item.type));
      // Generated image bytes go to attachment storage and are never replayed.
      if (item.type !== 'image_generation_call') this.set(raw.output_index, item, false);
    } else if (
      this.config.provider === 'openai-chat' &&
      this.config.serverTools?.[0]?.vendor === 'deepseek'
    ) {
      for (const choice of blocks(raw.choices)) {
        if (choice.index !== undefined && choice.index !== 0) continue;
        const steps = object(choice.delta).server_tool_calls;
        if (!Array.isArray(steps) || !steps.length) continue;
        if (steps.length <= 96 && Buffer.byteLength(JSON.stringify(steps)) <= maxReplayBytes) {
          this.chat = steps;
          this.hosted = true;
        } else this.invalid = true;
      }
    }
  }

  private set(index: unknown, block: Block, open: boolean) {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 96 ||
      this.parts.has(index) ||
      (this.bytes += Buffer.byteLength(JSON.stringify(block))) > maxReplayBytes
    ) {
      this.invalid = true;
      return;
    }
    this.parts.set(index, { block: structuredClone(block), open, json: '' });
  }

  private anthropic(raw: Block) {
    if (raw.type === 'message_start' || raw.type === 'message_delta') {
      const container = object(
        raw.container ?? object(raw.message).container ?? object(raw.delta).container,
      );
      if (typeof container.id === 'string') this.container = container.id;
      return;
    }
    if (raw.type === 'content_block_start') {
      const block = object(raw.content_block);
      this.hosted ||=
        block.type === 'server_tool_use' || String(block.type).endsWith('_tool_result');
      this.set(raw.index, block, true);
      return;
    }
    if (raw.type !== 'content_block_delta' && raw.type !== 'content_block_stop') return;
    const part = this.parts.get(Number(raw.index));
    if (!part?.open) {
      this.invalid = true;
      return;
    }
    if (raw.type === 'content_block_stop') {
      part.open = false;
      if (part.json) {
        try {
          part.block.input = JSON.parse(part.json);
        } catch {
          this.invalid = true;
        }
        part.json = '';
      }
      return;
    }
    const delta = object(raw.delta);
    if ((this.bytes += Buffer.byteLength(JSON.stringify(delta))) > maxReplayBytes) {
      this.invalid = true;
      return;
    }
    switch (delta.type) {
      case 'text_delta':
      case 'thinking_delta':
      case 'signature_delta': {
        const key = delta.type.slice(0, -6);
        if (typeof delta[key] !== 'string') {
          this.invalid = true;
          return;
        }
        part.block[key] = String(part.block[key] ?? '') + delta[key];
        break;
      }
      case 'input_json_delta':
        if (typeof delta.partial_json === 'string') part.json += delta.partial_json;
        else this.invalid = true;
        break;
      case 'citations_delta':
        part.block.citations = [...blocks(part.block.citations), delta.citation];
        break;
      default:
        this.invalid = true;
    }
  }

  finish(calls: readonly { id: string }[], paused: boolean): ServerToolReplay | undefined {
    if (!paused && !calls.length) return;
    if (!paused && !this.hosted && !this.container) return;
    if (this.invalid || [...this.parts.values()].some((part) => part.open)) throw invalid();
    const content = [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value.block);
    const replay: ServerToolReplay =
      this.config.provider === 'anthropic'
        ? {
            type: 'anthropic',
            blocks: content,
            ...(this.container ? { container: this.container } : {}),
          }
        : this.config.provider === 'openai-responses'
          ? { type: 'responses', blocks: content }
          : { type: 'deepseek-chat', blocks: this.chat };
    validateServerToolReplay(replay, this.config, calls);
    return replay;
  }
}

export function applyServerToolReplay(
  payload: Block,
  replays: readonly { replay: ServerToolReplay; marker: string; callIds: string[] }[],
) {
  for (const { replay, marker, callIds } of replays) {
    if (replay.type === 'anthropic') {
      let matches = 0;
      for (const message of blocks(payload.messages)) {
        if (message.role !== 'assistant') continue;
        message.content = blocks(message.content).flatMap((part) => {
          if (part.type !== 'text' || part.text !== marker) return [part];
          matches++;
          return replay.blocks;
        });
      }
      if (matches !== 1) throw invalid();
      if (replay.container) payload.container = replay.container;
    } else if (replay.type === 'responses') {
      let matches = 0;
      payload.input = blocks(payload.input).flatMap((item) => {
        const content = blocks(item.content);
        if (item.role !== 'assistant' || content.length !== 1 || content[0]?.text !== marker)
          return [item];
        matches++;
        return replay.blocks;
      });
      if (matches !== 1) throw invalid();
    } else {
      const matches = blocks(payload.messages).filter(
        (item) =>
          item.role === 'assistant' &&
          callIds.every((id) => blocks(item.tool_calls).some((call) => call.id === id)),
      );
      if (matches.length !== 1) throw invalid();
      matches[0].server_tool_calls = replay.blocks;
    }
  }
}
