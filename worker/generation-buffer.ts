import { streamBatches } from '../shared/stream-batches';
import type { StreamCounts } from '../shared/generation-metrics';
import type { StreamBatch } from '../shared/types';
import { GenerationCancelled, ProviderError } from './generation-errors';

// One bounded tail per running DO. It never retains the complete answer in memory.
export class GenerationBuffer {
  private content = '';
  private reasoning = '';
  private contentLength = 0;
  private reasoningLength = 0;
  private chunkSeq = 0;
  private offset = 0;
  private lastFlush: number;
  private failure?: Error;
  readonly counts?: StreamCounts;
  constructor(private readonly runId: string, private readonly messageId: string,
    private readonly persist: (batch: StreamBatch, counts?: StreamCounts) => boolean,
    metrics = false, private readonly now: () => number = Date.now) {
    this.lastFlush = now();
    if (metrics) this.counts = { textDeltas: 0, reasoningDeltas: 0 };
  }
  add(kind: 'content' | 'reasoning', delta: string) {
    if (this.failure) throw this.failure;
    if (this.counts) this.counts[kind === 'content' ? 'textDeltas' : 'reasoningDeltas']++;
    const length = kind === 'content' ? this.contentLength : this.reasoningLength;
    let accepted = delta.slice(0, Math.max(0, 100_000 - length));
    if (accepted.length < delta.length && /[\uD800-\uDBFF]$/.test(accepted) && /[\uDC00-\uDFFF]/.test(delta[accepted.length])) accepted = accepted.slice(0, -1);
    if (kind === 'content') { this.content += accepted; this.contentLength += accepted.length; }
    else { this.reasoning += accepted; this.reasoningLength += accepted.length; }
    if (this.content.length + this.reasoning.length >= 8000) this.flush();
    else this.tick();
    if (accepted.length !== delta.length) throw new ProviderError(kind === 'content' ? '回答已达到 100,000 字的原型限制。' : '思考内容已达到 100,000 字的原型限制。');
  }
  tick() { if (this.now() - this.lastFlush >= 100) this.flush(); }
  flush() {
    if (this.failure) throw this.failure;
    try {
      for (const batch of streamBatches(this.runId, this.messageId, this.chunkSeq, this.offset, this.content, this.reasoning)) {
        if (!this.persist(batch, this.counts)) throw new GenerationCancelled();
        this.chunkSeq = batch.chunkSeq; this.offset = batch.endOffset;
        this.content = this.content.slice(batch.content.length); this.reasoning = this.reasoning.slice(batch.reasoning.length);
      }
      this.lastFlush = this.now();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('Generation persistence failed');
      throw this.failure;
    }
  }
}
