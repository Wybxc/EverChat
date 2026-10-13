import type { Commit, CommitAck, StreamBatch, StreamCommit } from './types';

import { decodeBytes, encodeBytes } from './provider-stream';

export const STREAM_VERSION = 'raw-sse-v1' as const;
export const MAX_BATCH_BYTES = 8192;
export const MAX_COMMIT_BYTES = 64 * 1024;
export const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
export const payloadBytes = (payload: string) => encoder.encode(payload).byteLength;

// Offsets count original supplier bytes, including partial UTF-8 and partial SSE events.
export function* streamBatches(runId: string, messageId: string, chunkSeq: number, offset: number, bytes: Uint8Array): Generator<StreamBatch> {
  for (let index = 0; index < bytes.length; index += MAX_BATCH_BYTES) {
    const data = bytes.subarray(index, index + MAX_BATCH_BYTES);
    const endOffset = offset + data.byteLength;
    yield { version: STREAM_VERSION, runId, messageId, chunkSeq: ++chunkSeq, startOffset: offset, endOffset, data: encodeBytes(data) };
    offset = endOffset;
  }
}

export function validateBatch(batch: StreamBatch): Uint8Array {
  if (batch.version !== STREAM_VERSION || !Number.isSafeInteger(batch.chunkSeq) || batch.chunkSeq < 1
    || !Number.isSafeInteger(batch.startOffset) || batch.startOffset < 0 || !Number.isSafeInteger(batch.endOffset)
    || typeof batch.data !== 'string' || !batch.data || batch.data.length > Math.ceil(MAX_BATCH_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(batch.data)) throw new Error('Invalid stream batch');
  const bytes = decodeBytes(batch.data);
  if (!bytes.length || bytes.length > MAX_BATCH_BYTES || encodeBytes(bytes) !== batch.data || batch.endOffset !== batch.startOffset + bytes.length
    || batch.endOffset > MAX_STREAM_BYTES) throw new Error('Invalid stream batch size or offset');
  return bytes;
}

export function validateCommit(commit: StreamCommit): string {
  if (!Array.isArray(commit.batches) || !commit.batches.length || commit.batches.length > 32) throw new Error('Invalid stream commit');
  let previous: StreamBatch | undefined;
  for (const batch of commit.batches) {
    validateBatch(batch);
    if (batch.runId !== commit.runId || batch.messageId !== commit.messageId
      || (previous && (batch.startOffset !== previous.endOffset || batch.chunkSeq !== previous.chunkSeq + 1))) throw new Error('Stream commit gap or identity mismatch');
    previous = batch;
  }
  const payload = JSON.stringify(commit.batches);
  if (payloadBytes(payload) > MAX_COMMIT_BYTES) throw new Error('Stream commit exceeds buffer limit');
  return payload;
}

export function commitAck(commit: Commit): CommitAck {
  const first = commit.batches[0], last = commit.batches.at(-1)!;
  return { type: 'commit-ack', seq: commit.seq, runId: commit.runId, messageId: commit.messageId,
    firstChunkSeq: first.chunkSeq, lastChunkSeq: last.chunkSeq, startOffset: first.startOffset, endOffset: last.endOffset };
}
