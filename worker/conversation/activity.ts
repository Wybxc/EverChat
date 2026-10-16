import type { ConversationActivity } from '../../shared/conversation/activity';
import type { SqlQuery } from '../generation/metrics';

export const CONVERSATION_ACTIVITY_SCHEMA = `CREATE TABLE IF NOT EXISTS conversation_activity (
  id INTEGER PRIMARY KEY CHECK (id = 1), conversationId TEXT NOT NULL,
  version INTEGER NOT NULL, payload TEXT NOT NULL, pending INTEGER NOT NULL,
  attempts INTEGER NOT NULL, nextAt INTEGER NOT NULL
)`;
type ActivityRow = {
  conversationId: string;
  version: number;
  payload: string;
  pending: number;
  attempts: number;
  nextAt: number;
} & Record<string, SqlStorageValue>;
type ActiveRow = {
  conversationId: string;
  messageId: string;
  runId: string;
  status: 'queued' | 'running';
  cancelRequested: number;
  summaryStatus: string | null;
} & Record<string, SqlStorageValue>;

/** Called only by lifecycle records, in their owning transaction; raw stream commits bypass it. */
export class ConversationActivityJournal {
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
    private readonly live = () => true,
  ) {}
  snapshot(): ConversationActivity | undefined {
    const row = this.row();
    return row ? (JSON.parse(row.payload) as ConversationActivity) : undefined;
  }
  private row() {
    return this.query<ActivityRow>('SELECT * FROM conversation_activity WHERE id = 1').toArray()[0];
  }
  record(): ConversationActivity | undefined {
    const previous = this.row();
    const active = this.query<ActiveRow>(
      `SELECT r.conversationId, COALESCE(json_extract(own_summary.payload, '$.throughId'), m.id) AS messageId, m.runId, m.status,
      r.cancelRequested, summary.status AS summaryStatus FROM messages AS m
      JOIN runs AS r ON r.id = m.runId
      LEFT JOIN run_dependencies AS dependency ON dependency.runId = m.runId
      LEFT JOIN messages AS summary ON summary.id = dependency.summaryId
      LEFT JOIN message_summaries AS own_summary ON own_summary.messageId = m.id
      WHERE m.role = 'assistant' AND m.status IN ('queued', 'running')
      ORDER BY EXISTS (SELECT 1 FROM message_summaries WHERE messageId = m.id), m.rowid DESC LIMIT 1`,
    ).toArray()[0];
    if (!active && !previous) return;
    const status = active
      ? active.cancelRequested
        ? 'stopping'
        : active.status === 'running' || active.summaryStatus === 'running'
          ? 'running'
          : 'queued'
      : 'idle';
    const identity = active
      ? { status, messageId: active.messageId, runId: active.runId }
      : { status };
    if (previous) {
      const {
        version: _version,
        updatedAt: _updatedAt,
        ...oldIdentity
      } = JSON.parse(previous.payload) as ConversationActivity;
      if (JSON.stringify(oldIdentity) === JSON.stringify(identity)) return;
    }
    const next = {
      ...identity,
      version: (previous?.version ?? 0) + 1,
      updatedAt: this.now(),
    } as ConversationActivity;
    this.query(
      `INSERT INTO conversation_activity VALUES (1, ?, ?, ?, 1, 0, ?)
      ON CONFLICT(id) DO UPDATE SET conversationId = excluded.conversationId, version = excluded.version,
      payload = excluded.payload, pending = 1, attempts = 0, nextAt = excluded.nextAt`,
      active?.conversationId ?? previous!.conversationId,
      next.version,
      JSON.stringify(next),
      this.now(),
    );
    return next;
  }
  nextAlarm(): number | null {
    const row = this.row();
    return row?.pending ? row.nextAt : null;
  }
  async flush(publish: (id: string, activity: ConversationActivity) => Promise<void>) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this.live()) return;
      const row = this.row();
      if (!row?.pending || row.nextAt > this.now()) return;
      try {
        await publish(row.conversationId, JSON.parse(row.payload) as ConversationActivity);
        if (!this.live()) return;
        this.query(
          'UPDATE conversation_activity SET pending = 0, attempts = 0 WHERE version = ?',
          row.version,
        );
      } catch {
        if (!this.live()) return;
        this.query(
          'UPDATE conversation_activity SET attempts = attempts + 1, nextAt = ? WHERE version = ? AND pending = 1',
          this.now() + Math.min(30_000, 1000 * 2 ** Math.min(row.attempts, 5)),
          row.version,
        );
        return;
      }
    }
  }
}
