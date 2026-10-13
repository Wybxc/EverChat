import { MAX_BATCH_BYTES, MAX_COMMIT_BYTES, MAX_STREAM_BYTES, payloadBytes, streamBatches } from '../shared/stream-batches';
import type { StreamBatch } from '../shared/types';
import { GenerationCancelled, ProviderError } from './generation-errors';

export const PREVIEW_INTERVAL_MS = 100;
export const COMMIT_INTERVAL_MS = 1500;
export const COMMIT_TARGET_BYTES = 32 * 1024;

// Only the bounded uncommitted tail lives in the running DO's memory.
export class GenerationBuffer {
  private bytes: Uint8Array[] = [];
  private byteLength = 0;
  private receivedBytes = 0;
  private chunkSeq = 0;
  private offset = 0;
  private pending: StreamBatch[] = [];
  private pendingBytes = 2;
  private pendingRawBytes = 0;
  private lastPreview: number;
  private lastCommit: number;
  private failure?: Error;
  constructor(private readonly runId: string, private readonly messageId: string,
    private readonly persist: (batches: StreamBatch[]) => boolean,
    private readonly preview: (batch: StreamBatch) => void = () => {},
    private readonly now: () => number = Date.now) {
    this.lastPreview = this.lastCommit = now();
  }
  get previewTail(): readonly StreamBatch[] { return this.pending; }
  add(bytes: Uint8Array) {
    this.check();
    const accepted = Math.min(bytes.length, MAX_STREAM_BYTES - this.receivedBytes);
    for (let index = 0; index < accepted;) {
      const length = Math.min(accepted - index, MAX_BATCH_BYTES - this.byteLength);
      this.bytes.push(bytes.slice(index, index + length)); this.byteLength += length; this.receivedBytes += length; index += length;
      if (this.byteLength >= MAX_BATCH_BYTES) this.seal();
    }
    this.tick();
    if (accepted !== bytes.length) throw new ProviderError('供应商响应已达到 4 MiB 的原型限制。已保存部分内容，请主动重新生成。');
  }
  tick() {
    this.check();
    if (this.now() - this.lastPreview >= PREVIEW_INTERVAL_MS) this.seal();
    if (this.now() - this.lastCommit >= COMMIT_INTERVAL_MS) this.commit();
  }
  flush() { this.check(); this.seal(); this.commit(); }
  private check() { if (this.failure) throw this.failure; }
  private seal() {
    this.guard(() => {
      const input = new Uint8Array(this.byteLength);
      let index = 0; for (const part of this.bytes) { input.set(part, index); index += part.length; }
      for (const batch of streamBatches(this.runId, this.messageId, this.chunkSeq, this.offset, input)) {
        const bytes = payloadBytes(JSON.stringify(batch));
        if (this.pendingBytes + bytes + (this.pending.length ? 1 : 0) > MAX_COMMIT_BYTES || this.pending.length === 32) this.commit();
        this.pendingBytes += bytes + (this.pending.length ? 1 : 0);
        this.pending.push(batch); this.pendingRawBytes += batch.endOffset - batch.startOffset;
        this.preview(batch);
        this.chunkSeq = batch.chunkSeq; this.offset = batch.endOffset;
        this.bytes = []; this.byteLength = 0;
        if (this.pendingRawBytes >= COMMIT_TARGET_BYTES) this.commit();
      }
      this.lastPreview = this.now();
    });
  }
  private commit() {
    if (!this.pending.length) return;
    this.guard(() => {
      if (!this.persist([...this.pending])) throw new GenerationCancelled();
      this.pending = []; this.pendingBytes = 2; this.pendingRawBytes = 0; this.lastCommit = this.now();
    });
  }
  private guard(operation: () => void) {
    this.check();
    try { operation(); }
    catch (error) {
      this.failure = error instanceof Error ? error : new Error('Generation persistence failed');
      throw this.failure;
    }
  }
}
