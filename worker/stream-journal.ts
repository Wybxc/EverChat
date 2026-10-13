import { appendMessage, type Message, type StreamBatch, type StreamCommit } from '../shared/types';
import { STREAM_VERSION, validateCommit } from '../shared/stream-batches';
import type { SqlQuery } from './generation-metrics';

type CommitRow = { chunkSeq: number; endSeq: number; startOffset: number; endOffset: number; payload: string } & Record<string, SqlStorageValue>;

export const STREAM_JOURNAL_SCHEMA = `CREATE TABLE IF NOT EXISTS stream_commits (
  runId TEXT NOT NULL, chunkSeq INTEGER NOT NULL, endSeq INTEGER NOT NULL, startOffset INTEGER NOT NULL, endOffset INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (runId, chunkSeq)
) WITHOUT ROWID`;

// The caller atomically commits the journal, progress and event, or compacts the terminal snapshot.
export class StreamJournal {
  constructor(private readonly query: SqlQuery) {}
  append(commit: StreamCommit) {
    const payload = validateCommit(commit), first = commit.batches[0], last = commit.batches.at(-1)!;
    const existing = this.query<CommitRow>('SELECT * FROM stream_commits WHERE runId = ? AND chunkSeq = ?', commit.runId, first.chunkSeq).toArray()[0];
    if (existing) {
      if (existing.startOffset !== first.startOffset || existing.endOffset !== last.endOffset || existing.endSeq !== last.chunkSeq || existing.payload !== payload) throw new Error('Conflicting stream commit');
      return false;
    }
    this.query('INSERT INTO stream_commits (runId, chunkSeq, endSeq, startOffset, endOffset, payload) VALUES (?, ?, ?, ?, ?, ?)',
      commit.runId, first.chunkSeq, last.chunkSeq, first.startOffset, last.endOffset, payload);
    return true;
  }
  materialize(message: Message): Message {
    if (message.streamVersion !== STREAM_VERSION || !message.runId) return message;
    const rows = this.query<CommitRow>('SELECT * FROM stream_commits WHERE runId = ? ORDER BY chunkSeq', message.runId).toArray();
    let result = message, sequence = 0;
    for (const row of rows) {
      const batches = JSON.parse(row.payload) as StreamBatch[];
      validateCommit({ runId: message.runId, messageId: message.id, batches });
      const first = batches[0], last = batches.at(-1)!;
      if (row.chunkSeq !== first.chunkSeq || row.endSeq !== last.chunkSeq || row.startOffset !== first.startOffset || row.endOffset !== last.endOffset) throw new Error('Stream journal boundary mismatch');
      for (const batch of batches) {
        if (batch.chunkSeq !== ++sequence) throw new Error('Stream sequence gap');
        result = appendMessage(result, batch);
      }
    }
    return result;
  }
  compact(message: Message) {
    this.query('UPDATE messages SET content = ?, reasoning = ?, durableOffset = ? WHERE id = ?',
      message.content, message.reasoning ?? '', message.durableOffset ?? 0, message.id);
    this.query('DELETE FROM stream_commits WHERE runId = ?', message.runId);
  }
}
