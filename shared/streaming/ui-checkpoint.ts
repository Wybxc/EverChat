import { getToolOrDynamicToolName, isToolUIPart, type UIMessage, type UIMessageChunk } from 'ai';

// A valid 64 KiB tool argument/result also needs its standard SDK envelope.
// This is an in-memory SDK apply bound, independent of durable/wire microbatches.
export const MAX_UI_APPLY_BYTES = 128 * 1024;

export interface UIActiveBlock {
  type: 'text' | 'reasoning';
  id: string;
  index: number;
}

/** Only active IDs need storage beside the canonical parts, never another text copy. */
export interface UIMessageCheckpoint {
  message: UIMessage;
  active: UIActiveBlock[];
}

/** Rebuild SDK active-ID maps; seeding messages alone cannot restore text-delta targets. */
export function* replayUIMessage({
  message,
  active,
}: UIMessageCheckpoint): Generator<UIMessageChunk> {
  if (message.role !== 'assistant') throw new Error('Only an assistant answer can be resumed');
  const byIndex = new Map<number, UIActiveBlock>();
  const ids = new Set<string>();
  for (const block of active) {
    const part = message.parts[block.index];
    const key = `${block.type}:${block.id}`;
    if (
      (block.type !== 'text' && block.type !== 'reasoning') ||
      !Number.isSafeInteger(block.index) ||
      block.index < 0 ||
      !block.id ||
      typeof block.id !== 'string' ||
      block.id.length > 256 ||
      byIndex.has(block.index) ||
      ids.has(key) ||
      !part ||
      part.type !== block.type ||
      part.state !== 'streaming' ||
      (part.type === 'reasoning' && part.id !== block.id)
    )
      throw new Error('Invalid UI active-block checkpoint');
    byIndex.set(block.index, block);
    ids.add(key);
  }
  for (const [index, part] of message.parts.entries()) {
    if (
      (part.type === 'text' || part.type === 'reasoning') &&
      part.state === 'streaming' &&
      !byIndex.has(index)
    )
      throw new Error('Missing UI active-block checkpoint');
  }
  yield { type: 'start', messageId: message.id, messageMetadata: message.metadata };
  for (const [index, part] of message.parts.entries()) {
    if (part.type === 'text' || part.type === 'reasoning') {
      const block = byIndex.get(index);
      let id = block?.id ?? (part.type === 'reasoning' ? part.id : undefined);
      if (!id) {
        id = `checkpoint:${index}`;
        while (ids.has(`${part.type}:${id}`)) id = `_${id}`;
      }
      yield { type: `${part.type}-start`, id, providerMetadata: part.providerMetadata };
      // A replay is semantic content, not an event log. Bound each emitted text
      // fragment, including JSON escaping; the caller still bounds whole batches.
      for (let offset = 0; offset < part.text.length;) {
        let end = Math.min(part.text.length, offset + 1024);
        if (end < part.text.length && /[\uD800-\uDBFF]/.test(part.text[end - 1])) end--;
        yield { type: `${part.type}-delta`, id, delta: part.text.slice(offset, end) };
        offset = end;
      }
      if (!block)
        yield part.type === 'text'
          ? { type: 'text-end', id, citations: part.citations }
          : { type: 'reasoning-end', id };
    } else if (part.type === 'step-start') yield { type: 'start-step' };
    else if (isToolUIPart(part)) {
      // Tool arguments enter the public stream only after a complete, identified
      // native call. An unfinished partial-JSON parser is not a durable checkpoint.
      if (!['input-available', 'output-available', 'output-error'].includes(part.state))
        throw new Error('Unsupported UI tool checkpoint state');
      const toolName = getToolOrDynamicToolName(part),
        dynamic = part.type === 'dynamic-tool';
      const common = {
        toolCallId: part.toolCallId,
        toolName,
        input: part.input,
        dynamic,
        title: part.title,
        toolMetadata: part.toolMetadata,
      };
      if (part.state === 'output-error') {
        yield { type: 'tool-input-error', ...common, errorText: part.errorText };
      } else {
        yield { type: 'tool-input-available', ...common };
        if (part.state === 'output-available')
          yield {
            type: 'tool-output-available',
            toolCallId: part.toolCallId,
            output: part.output,
            preliminary: part.preliminary,
            toolMetadata: part.toolMetadata,
          };
      }
    } else if (part.type.startsWith('data-') && 'data' in part) {
      yield { type: part.type, id: part.id, data: part.data };
    } else if (part.type === 'source-url' || part.type === 'source-document') {
      yield part;
    } else if (part.type === 'file') {
      yield { type: 'file', mediaType: part.mediaType, url: part.url };
    } else throw new Error(`Unsupported UI checkpoint part: ${part.type}`);
  }
}
