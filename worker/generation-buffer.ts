import { MAX_COMMIT_BYTES, payloadBytes, streamBatches } from '../shared/stream-batches';
import type { StreamCounts } from '../shared/generation-metrics';
import type { StreamBatch } from '../shared/types';
import { GenerationCancelled, ProviderError } from './generation-errors';

export const PREVIEW_INTERVAL_MS = 100;
export const COMMIT_INTERVAL_MS = 1500;
export const COMMIT_TARGET_BYTES = 32 * 1024;

// Only the bounded uncommitted tail lives in the running DO's memory.
export class GenerationBuffer {
  private content = '';
  private reasoning = '';
  private contentLength = 0;
  private reasoningLength = 0;
  private chunkSeq = 0;
  private offset = 0;
  private pending: StreamBatch[] = [];
  private pendingBytes = 2;
  private lastPreview: number;
  private lastCommit: number;
  private failure?: Error;
  readonly counts?: StreamCounts;
  constructor(private readonly runId: string, private readonly messageId: string,
    private readonly persist: (batches: StreamBatch[], counts?: StreamCounts) => boolean,
    private readonly preview: (batch: StreamBatch) => void = () => {},
    metrics = false, private readonly now: () => number = Date.now) {
    this.lastPreview = this.lastCommit = now();
    if (metrics) this.counts = { textDeltas: 0, reasoningDeltas: 0 };
  }
  get previewTail(): readonly StreamBatch[] { return this.pending; }
  add(kind: 'content' | 'reasoning', delta: string) {
    this.check();
    if (this.counts) this.counts[kind === 'content' ? 'textDeltas' : 'reasoningDeltas']++;
    const length = kind === 'content' ? this.contentLength : this.reasoningLength;
    let accepted = delta.slice(0, Math.max(0, 100_000 - length));
    if (accepted.length < delta.length && /[\uD800-\uDBFF]$/.test(accepted) && /[\uDC00-\uDFFF]/.test(delta[accepted.length])) accepted = accepted.slice(0, -1);
    if (kind === 'content') { this.content += accepted; this.contentLength += accepted.length; }
    else { this.reasoning += accepted; this.reasoningLength += accepted.length; }
    if (this.content.length + this.reasoning.length >= 8000) this.seal();
    this.tick();
    if (accepted.length !== delta.length) throw new ProviderError(kind === 'content' ? '回答已达到 100,000 字的原型限制。' : '思考内容已达到 100,000 字的原型限制。');
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
      for (const batch of streamBatches(this.runId, this.messageId, this.chunkSeq, this.offset, this.content, this.reasoning)) {
        const bytes = payloadBytes(JSON.stringify(batch));
        if (this.pendingBytes + bytes + (this.pending.length ? 1 : 0) > MAX_COMMIT_BYTES || this.pending.length === 32) this.commit();
        this.pendingBytes += bytes + (this.pending.length ? 1 : 0);
        this.pending.push(batch);
        this.preview(batch);
        this.chunkSeq = batch.chunkSeq; this.offset = batch.endOffset;
        this.content = this.content.slice(batch.content.length); this.reasoning = this.reasoning.slice(batch.reasoning.length);
        if (this.pendingBytes >= COMMIT_TARGET_BYTES) this.commit();
      }
      this.lastPreview = this.now();
    });
  }
  private commit() {
    if (!this.pending.length) return;
    this.guard(() => {
      if (!this.persist([...this.pending], this.counts)) throw new GenerationCancelled();
      this.pending = []; this.pendingBytes = 2; this.lastCommit = this.now();
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
