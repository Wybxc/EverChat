import type { StreamBatch } from './types';

export const STREAM_VERSION = 'semantic-delta-v1' as const;
export const MAX_BATCH_BYTES = 64 * 1024;
const encoder = new TextEncoder();

// Byte offsets refer to a canonical JSON delta stream, not to supplier SSE bytes.
export const batchPayload = (content: string, reasoning: string) => JSON.stringify({ content, reasoning });
export const payloadBytes = (payload: string) => encoder.encode(payload).byteLength;

function prefixLength(text: string, limit: number) {
  let length = Math.min(text.length, limit);
  if (length < text.length && length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]) && /[\uDC00-\uDFFF]/.test(text[length])) length--;
  return length;
}

export function* streamBatches(runId: string, messageId: string, chunkSeq: number, offset: number, content: string, reasoning: string): Generator<StreamBatch> {
  let textIndex = 0, reasoningIndex = 0;
  while (textIndex < content.length || reasoningIndex < reasoning.length) {
    // JSON escapes need at most six bytes per UTF-16 unit; reserve space for the object keys.
    const textLength = prefixLength(content.slice(textIndex), 8000);
    const thoughtLength = prefixLength(reasoning.slice(reasoningIndex), 8000 - textLength);
    const text = content.slice(textIndex, textIndex + textLength), thought = reasoning.slice(reasoningIndex, reasoningIndex + thoughtLength);
    const endOffset = offset + payloadBytes(batchPayload(text, thought));
    yield { version: STREAM_VERSION, runId, messageId, chunkSeq: ++chunkSeq, startOffset: offset, endOffset, content: text, reasoning: thought };
    offset = endOffset; textIndex += textLength; reasoningIndex += thoughtLength;
  }
}

export function validateBatch(batch: StreamBatch) {
  if (batch.version !== STREAM_VERSION || !Number.isSafeInteger(batch.chunkSeq) || batch.chunkSeq < 1
    || !Number.isSafeInteger(batch.startOffset) || batch.startOffset < 0 || !Number.isSafeInteger(batch.endOffset)
    || typeof batch.content !== 'string' || typeof batch.reasoning !== 'string' || (!batch.content && !batch.reasoning)) throw new Error('Invalid stream batch');
  const payload = batchPayload(batch.content, batch.reasoning);
  const size = payloadBytes(payload);
  if (size > MAX_BATCH_BYTES || batch.endOffset !== batch.startOffset + size) throw new Error('Invalid stream batch size or offset');
  return payload;
}
