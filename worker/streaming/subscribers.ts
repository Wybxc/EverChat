import type { StreamBatch } from '../../shared/streaming/protocol';

export type Attachment = { expires: number; blocked?: boolean; runId?: string; messageId?: string; sentOffset?: number; ackedOffset?: number; ackAt?: number };
const SUBSCRIBER_WINDOW_BYTES = 128 * 1024;

export class ConversationSubscribers {
 constructor(private readonly ctx: DurableObjectState, private readonly measure: (packet: string, recipients: number) => void) {}
send(packet: string, batch?: StreamBatch, target?: WebSocket) {
    let recipients = 0;
    for (const socket of target ? [target] : this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.blocked) continue;
      if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); continue; }
      if (batch) {
        if (attachment.runId !== batch.runId || attachment.messageId !== batch.messageId) {
          Object.assign(attachment, { runId: batch.runId, messageId: batch.messageId, sentOffset: batch.startOffset, ackedOffset: batch.startOffset, ackAt: Date.now() });
        }
        if (attachment.sentOffset !== batch.startOffset || batch.endOffset - attachment.ackedOffset! > SUBSCRIBER_WINDOW_BYTES
          || (attachment.sentOffset! > attachment.ackedOffset! && Date.now() - attachment.ackAt! > 30_000)) {
          attachment.blocked = true; socket.serializeAttachment(attachment);
          socket.close(4002, 'Reconnect to sync'); continue;
        }
        attachment.sentOffset = batch.endOffset;
        socket.serializeAttachment(attachment);
      }
      try { socket.send(packet); recipients++; }
      catch { socket.close(1011, 'Reconnect to sync'); }
    }
    this.measure(packet, recipients);
  }
acknowledge(socket: WebSocket, data: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as Attachment;
    if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); return; }
    if (data === 'session-check') return;
    try {
      if (typeof data !== 'string' || data.length > 1024) throw new Error('Invalid acknowledgement');
      const ack = JSON.parse(data) as { type: string; runId: string; messageId: string; offset: number };
      if (ack.type !== 'preview-ack') throw new Error('Invalid acknowledgement');
      if (ack.runId !== attachment.runId || ack.messageId !== attachment.messageId) return;
      if (!Number.isSafeInteger(ack.offset) || ack.offset < attachment.ackedOffset! || ack.offset > attachment.sentOffset!) return;
      attachment.ackedOffset = ack.offset; attachment.ackAt = Date.now();
      socket.serializeAttachment(attachment);
    } catch { socket.close(4002, 'Reconnect to sync'); }
  }
}
