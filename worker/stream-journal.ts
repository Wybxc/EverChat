import { appendMessage, type Message, type StreamBatch } from '../shared/types';
import { STREAM_VERSION, validateBatch } from '../shared/stream-batches';
import type { SqlQuery } from './generation-metrics';

type BatchRow = { chunkSeq: number; startOffset: number; endOffset: number; payload: string } & Record<string, SqlStorageValue>;

export const STREAM_JOURNAL_SCHEMA = `CREATE TABLE IF NOT EXISTS stream_batches (
  runId TEXT NOT NULL, chunkSeq INTEGER NOT NULL, startOffset INTEGER NOT NULL, endOffset INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (runId, chunkSeq)
) WITHOUT ROWID`;

// All methods are synchronous. The caller groups append/ack and compact/terminal into a storage transaction.
export class StreamJournal {
  constructor(private readonly query: SqlQuery) {}
  append(batch: StreamBatch) {
    const payload = validateBatch(batch);
    const existing = this.query<BatchRow>('SELECT chunkSeq, startOffset, endOffset, payload FROM stream_batches WHERE runId = ? AND chunkSeq = ?', batch.runId, batch.chunkSeq).toArray()[0];
    if (existing) {
      if (existing.startOffset !== batch.startOffset || existing.endOffset !== batch.endOffset || existing.payload !== payload) throw new Error('Conflicting stream batch');
      return false;
    }
    this.query('INSERT INTO stream_batches (runId, chunkSeq, startOffset, endOffset, payload) VALUES (?, ?, ?, ?, ?)',
      batch.runId, batch.chunkSeq, batch.startOffset, batch.endOffset, payload);
    return true;
  }
  materialize(message: Message): Message {
    if (message.streamVersion !== STREAM_VERSION || !message.runId) return message;
    const rows = this.query<BatchRow>('SELECT chunkSeq, startOffset, endOffset, payload FROM stream_batches WHERE runId = ? ORDER BY chunkSeq', message.runId).toArray();
    let result = message;
    let sequence = 0;
    for (const row of rows) {
      if (row.chunkSeq !== ++sequence) throw new Error('Stream sequence gap');
      const delta = JSON.parse(row.payload) as { content: string; reasoning: string };
      const batch: StreamBatch = { version: STREAM_VERSION, runId: message.runId, messageId: message.id, ...row, ...delta };
      result = appendMessage(result, batch);
    }
    return result;
  }
  compact(message: Message) {
    this.query('UPDATE messages SET content = ?, reasoning = ?, durableOffset = ? WHERE id = ?',
      message.content, message.reasoning ?? '', message.durableOffset ?? 0, message.id);
    this.query('DELETE FROM stream_batches WHERE runId = ?', message.runId);
  }
}
