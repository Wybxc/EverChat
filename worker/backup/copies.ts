import type { ErrorIssue } from '../../shared/errors/descriptor';
import { problem } from '../../shared/errors/descriptor';
import { HttpError } from '../http/response';

const COPY_LEASE = 10 * 60_000;
const COPY_RETENTION = 7 * 24 * 60 * 60_000,
  MAX_COPY_RECORDS = 1000,
  MAX_ACTIVE_COPIES = 2;
export type CopyResult =
  { id: string; viewHeadId: string | null } | { error: string; issue?: ErrorIssue; status: number };
type CopyJob = {
  id: string;
  sourceId: string;
  messageId: string | null;
  status: string;
  createdAt: number;
  lease: number;
  viewHeadId: string | null;
  copiedHeadId: string | null;
  error: string | null;
  errorStatus: number | null;
} & Record<string, SqlStorageValue>;

/** Metadata only. File bytes and message bodies never enter this ledger. */
export class CopyJobs {
  readonly active = new Map<string, Promise<CopyResult>>();
  constructor(private storage: DurableObjectStorage) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS conversation_copies (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL,
      messageId TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL, lease INTEGER NOT NULL, error TEXT, errorStatus INTEGER,
      viewHeadId TEXT, copiedHeadId TEXT)`);
    storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS conversation_copies_status ON conversation_copies(status, lease)',
    );
  }
  get(id: string) {
    return this.storage.sql
      .exec<CopyJob>('SELECT * FROM conversation_copies WHERE id = ?', id)
      .toArray()[0];
  }
  pending() {
    return this.storage.sql
      .exec<CopyJob>(
        "SELECT * FROM conversation_copies WHERE status = 'copying' ORDER BY createdAt",
      )
      .toArray();
  }
  begin(id: string, sourceId: string, messageId?: string, viewHeadId?: string) {
    this.storage.sql.exec(
      "DELETE FROM conversation_copies WHERE status != 'copying' AND createdAt < ?",
      Date.now() - COPY_RETENTION,
    );
    if (this.pending().length >= MAX_ACTIVE_COPIES)
      throw new HttpError(
        429,
        '同时最多复制 2 个对话，请稍后重试。',
        undefined,
        problem('OPERATION_BUSY'),
      );
    if (
      this.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversation_copies')
        .one().count >= MAX_COPY_RECORDS
    )
      throw new HttpError(
        429,
        '近期复制次数已达上限，请稍后重试。',
        undefined,
        problem('OPERATION_BUSY'),
      );
    this.storage.sql.exec(
      "INSERT INTO conversation_copies (id, sourceId, messageId, status, createdAt, lease, error, errorStatus, viewHeadId) VALUES (?, ?, ?, 'copying', ?, ?, NULL, NULL, ?)",
      id,
      sourceId,
      messageId ?? null,
      Date.now(),
      Date.now() + COPY_LEASE,
      viewHeadId ?? null,
    );
  }
  requireActive(id: string) {
    const row = this.get(id);
    if (!row || row.status !== 'copying')
      throw new HttpError(
        row?.errorStatus ?? 409,
        row?.error ?? '复制已停止。',
        undefined,
        problem('BACKUP_INVALID'),
      );
    if (row.lease <= Date.now())
      throw new HttpError(
        408,
        '复制超过 10 分钟，请重新尝试。',
        undefined,
        problem('BACKUP_INVALID'),
      );
    return row;
  }
  fail(id: string, error: HttpError) {
    this.storage.sql.exec(
      "UPDATE conversation_copies SET status = 'failed', lease = 0, error = ?, errorStatus = ? WHERE id = ? AND status = 'copying'",
      error.message,
      error.status,
      id,
    );
  }
  complete(id: string, copiedHeadId: string | null) {
    this.requireActive(id);
    this.storage.sql.exec(
      "UPDATE conversation_copies SET status = 'completed', lease = 0, copiedHeadId = ? WHERE id = ?",
      copiedHeadId,
      id,
    );
  }
  nextMaintenance() {
    return this.pending().reduce(
      (next, row) => Math.min(next, this.active.has(row.id) ? row.lease : Date.now() + 1000),
      Infinity,
    );
  }
}
