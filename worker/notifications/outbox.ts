import {
  completionId,
  completionIsRecent,
  NOTIFICATION_TTL,
  type AnswerCompletion,
} from '../../shared/notifications/protocol';
import type { SqlQuery } from '../generation/metrics';

export const COMPLETION_OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS answer_notification_outbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
)`;
type Row = { id: string; payload: string; attempts: number; expires: number } & Record<
  string,
  SqlStorageValue
>;

/** Only new successful model completions enter this bounded external-delivery outbox. */
export class CompletionOutbox {
  private flushing = false;
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {}
  record(completion: AnswerCompletion) {
    this.query(
      'INSERT OR IGNORE INTO answer_notification_outbox(id, payload, expires, nextAt) VALUES (?, ?, ?, ?)',
      completionId(completion),
      JSON.stringify(completion),
      completion.completedAt + NOTIFICATION_TTL,
      this.now(),
    );
  }
  nextAlarm() {
    return this.query<{ next: number | null }>(
      'SELECT MIN(nextAt) AS next FROM answer_notification_outbox',
    ).one().next;
  }
  async flush(publish: (completion: AnswerCompletion) => Promise<void>) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const row of this.query<Row>(
        'SELECT * FROM answer_notification_outbox WHERE nextAt <= ? ORDER BY nextAt LIMIT 8',
        this.now(),
      ).toArray()) {
        const completion = JSON.parse(row.payload) as AnswerCompletion;
        if (!completionIsRecent(completion, this.now())) {
          this.query('DELETE FROM answer_notification_outbox WHERE id = ?', row.id);
          continue;
        }
        try {
          await publish(completion);
          this.query('DELETE FROM answer_notification_outbox WHERE id = ?', row.id);
        } catch {
          this.query(
            'UPDATE answer_notification_outbox SET attempts = attempts + 1, nextAt = ? WHERE id = ?',
            Math.min(
              row.expires,
              this.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6)),
            ),
            row.id,
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
