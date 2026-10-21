import { applyChange, appendMessage } from './apply-change';
import {
  type Commit,
  type CommitAck,
  type Snapshot,
  type StreamBatch,
  type SyncPacket,
} from './protocol';
import { MAX_COMMIT_BYTES, validateBatch } from './batches';
import { messageText } from '../conversation/content';
import { validReasoningBreaks } from '../web-tools/tasks';

function validToolPositions(snapshot: Snapshot) {
  return snapshot.messages.every(
    (message) =>
      !message.tools || validReasoningBreaks(message.tools, messageText(message, 'reasoning')),
  );
}

function assertToolPositions(snapshot: Snapshot) {
  if (!validToolPositions(snapshot)) throw new Error('Tool reasoning position mismatch');
  return snapshot;
}

// Preview state is ephemeral. Only durable can be cached, exported or used to resume.
export class StreamSync {
  durable: Snapshot;
  view: Snapshot;
  private pending = new Map<string, StreamBatch[]>();
  constructor(initial: Snapshot = { messages: [], seq: 0 }) {
    if (!validToolPositions(initial)) initial = { messages: [], seq: 0 };
    this.durable = initial;
    this.view = initial;
  }
  get hasPreview() {
    return this.pending.size > 0;
  }
  resetPreview() {
    this.pending.clear();
    this.view = this.durable;
  }
  receive(packet: SyncPacket): boolean {
    // A confirmed deletion is permanent, including across reconnects and delayed packets.
    if (this.durable.deletedAt) return false;
    const previous = this.durable;
    if (packet.type === 'resync') throw new Error('Fresh state required');
    if (packet.type === 'deleted') {
      this.durable = { messages: [], seq: this.durable.seq, deletedAt: packet.deletedAt };
      this.resetPreview();
    } else if (packet.type === 'snapshot') {
      this.durable = assertToolPositions(packet.snapshot);
      this.resetPreview();
    } else if (packet.type === 'state') {
      if (
        !Number.isSafeInteger(packet.after) ||
        packet.after < 0 ||
        packet.after > this.durable.seq ||
        (this.durable.epoch && packet.snapshot.epoch !== this.durable.epoch)
      )
        throw new Error('State baseline mismatch');
      // A heartbeat can use an older cursor while live commits are in flight.
      // State includes every changed message since that cursor at its latest version.
      if (packet.snapshot.seq <= this.durable.seq) return false;
      assertToolPositions(packet.snapshot);
      const messages = new Map(this.durable.messages.map((message) => [message.id, message]));
      for (const message of packet.snapshot.messages) messages.set(message.id, message);
      this.durable = { ...this.durable, ...packet.snapshot, messages: [...messages.values()] };
      this.rebase();
    } else if (packet.type === 'ready') {
      if (packet.seq !== this.durable.seq) throw new Error('Sync readiness gap');
    } else if (packet.type === 'preview') this.preview(packet.batch);
    else {
      const change = packet.type === 'commit-ack' ? this.confirm(packet) : packet;
      if (!change) return false;
      this.durable = assertToolPositions(applyChange(this.durable, change));
      if (this.durable !== previous) this.rebase();
    }
    return this.durable !== previous;
  }
  private preview(batch: StreamBatch) {
    validateBatch(batch);
    const durable = this.durable.messages.find((message) => message.id === batch.messageId);
    if (!durable || durable.runId !== batch.runId) throw new Error('Preview identity mismatch');
    if (batch.endOffset <= (durable.durableOffset ?? 0)) return;
    const pending = this.pending.get(batch.messageId) ?? [];
    const duplicate = pending.find((value) => value.chunkSeq === batch.chunkSeq);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(batch))
        throw new Error('Conflicting preview');
      return;
    }
    const last = pending.at(-1);
    if (last && batch.chunkSeq !== last.chunkSeq + 1) throw new Error('Preview sequence gap');
    if (batch.endOffset - (durable.durableOffset ?? 0) > MAX_COMMIT_BYTES * 2)
      throw new Error('Preview buffer limit');
    const index = this.view.messages.findIndex((message) => message.id === batch.messageId),
      message = this.view.messages[index];
    const appended = appendMessage(
      { ...message, durableOffset: message.liveOffset ?? message.durableOffset },
      batch,
    );
    const messages = [...this.view.messages];
    messages[index] = {
      ...appended,
      durableOffset: durable.durableOffset,
      liveOffset: batch.endOffset,
    };
    this.view = { ...this.durable, messages };
    this.pending.set(batch.messageId, [...pending, batch]);
  }
  private confirm(ack: CommitAck): Commit | null {
    if (ack.seq <= this.durable.seq) return null;
    const batches = (this.pending.get(ack.messageId) ?? []).filter(
      (batch) => batch.endOffset <= ack.endOffset,
    );
    const first = batches[0],
      last = batches.at(-1);
    if (
      !first ||
      !last ||
      first.runId !== ack.runId ||
      first.chunkSeq !== ack.firstChunkSeq ||
      last.chunkSeq !== ack.lastChunkSeq ||
      first.startOffset !== ack.startOffset ||
      last.endOffset !== ack.endOffset
    )
      throw new Error('Missing preview for durable confirmation');
    return { type: 'commit', seq: ack.seq, runId: ack.runId, messageId: ack.messageId, batches };
  }
  private rebase() {
    const pending = new Map(this.pending);
    this.resetPreview();
    for (const [id, batches] of pending) {
      const message = this.durable.messages.find((value) => value.id === id);
      if (!message || message.status !== 'running') continue;
      for (const batch of batches)
        if (batch.runId === message.runId && batch.endOffset > (message.durableOffset ?? 0))
          this.preview(batch);
    }
  }
}
