import {
  MAX_BATCH_BYTES,
  MAX_COMMIT_BYTES,
  payloadBytes,
  streamBatches,
} from '../../shared/streaming/batches';
import type { StreamBatch } from '../../shared/streaming/protocol';
import { GenerationCancelled } from './errors';

const PREVIEW_INTERVAL_MS = 100;
const COMMIT_INTERVAL_MS = 1500;
const COMMIT_TARGET_BYTES = 32 * 1024;

// Only the bounded uncommitted tail lives in the running DO's memory.
export class GenerationBuffer {
  private bytes: Uint8Array[] = [];
  private byteLength = 0;
  private chunkSeq = 0;
  private offset = 0;
  private pending: StreamBatch[] = [];
  private pendingBytes = 2;
  private pendingRawBytes = 0;
  private lastPreview: number;
  private lastCommit: number;
  private failure?: Error;
  private running?: Promise<void>;
  constructor(
    private readonly runId: string,
    private readonly messageId: string,
    private readonly persist: (batches: StreamBatch[]) => boolean | Promise<boolean>,
    private readonly preview: (batch: StreamBatch) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.lastPreview = this.lastCommit = now();
  }
  get previewTail(): readonly StreamBatch[] {
    return this.pending;
  }
  get busy() {
    return this.running !== undefined;
  }
  add(bytes: Uint8Array) {
    return this.run(async () => {
      for (let index = 0; index < bytes.length;) {
        const length = Math.min(bytes.length - index, MAX_BATCH_BYTES - this.byteLength);
        this.bytes.push(bytes.slice(index, index + length));
        this.byteLength += length;
        index += length;
        if (this.byteLength >= MAX_BATCH_BYTES) await this.seal();
      }
      await this.tickNow();
    });
  }
  tick() {
    // Slow persistence must not build a timer-job queue behind the active write.
    return this.running ?? this.run(() => this.tickNow());
  }
  flush() {
    return this.run(async () => {
      await this.seal();
      await this.commit();
    });
  }
  private async tickNow() {
    if (this.now() - this.lastPreview >= PREVIEW_INTERVAL_MS) await this.seal();
    if (this.now() - this.lastCommit >= COMMIT_INTERVAL_MS) await this.commit();
  }
  private check() {
    if (this.failure) throw this.failure;
  }
  private async seal() {
    const input = new Uint8Array(this.byteLength);
    let index = 0;
    for (const part of this.bytes) {
      input.set(part, index);
      index += part.length;
    }
    for (const batch of streamBatches(
      this.runId,
      this.messageId,
      this.chunkSeq,
      this.offset,
      input,
    )) {
      const bytes = payloadBytes(JSON.stringify(batch));
      if (
        this.pendingBytes + bytes + (this.pending.length ? 1 : 0) > MAX_COMMIT_BYTES ||
        this.pending.length === 32
      )
        await this.commit();
      this.pendingBytes += bytes + (this.pending.length ? 1 : 0);
      this.pending.push(batch);
      this.pendingRawBytes += batch.endOffset - batch.startOffset;
      this.preview(batch);
      this.chunkSeq = batch.chunkSeq;
      this.offset = batch.endOffset;
      this.bytes = [];
      this.byteLength = 0;
      if (this.pendingRawBytes >= COMMIT_TARGET_BYTES) await this.commit();
    }
    this.lastPreview = this.now();
  }
  private async commit() {
    if (!this.pending.length) return;
    if (!(await this.persist([...this.pending]))) throw new GenerationCancelled();
    this.pending = [];
    this.pendingBytes = 2;
    this.pendingRawBytes = 0;
    this.lastCommit = this.now();
  }
  private async run(operation: () => Promise<void>) {
    while (this.running) await this.running;
    this.check();
    const running = Promise.resolve().then(operation);
    this.running = running;
    try {
      await running;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('Generation persistence failed');
      throw this.failure;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }
}
