import { cleanTitle, type TitleSource, type TitleTaskInfo } from '../../shared/conversation/titles';
import type { SqlQuery } from '../generation/metrics';

export const TITLE_INDEX_SCHEMA = `CREATE TABLE IF NOT EXISTS conversation_titles (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, version INTEGER NOT NULL, task TEXT
);
CREATE TABLE IF NOT EXISTS title_reservations (
  taskId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, version INTEGER NOT NULL
);`;
type Row = { source: TitleSource; version: number; task: string | null } & Record<
  string,
  SqlStorageValue
>;

/** Called inside the Library transaction that owns the corresponding title. */
export class LibraryTitles {
  constructor(private readonly query: SqlQuery) {}
  create(id: string, source: TitleSource) {
    this.query('INSERT OR IGNORE INTO conversation_titles VALUES (?, ?, 1, NULL)', id, source);
  }
  private current(id: string) {
    return this.query<Row>(
      'SELECT source,version,task FROM conversation_titles WHERE id=?',
      id,
    ).toArray()[0];
  }
  manual(id: string) {
    this.create(id, 'manual');
    this.query(
      "UPDATE conversation_titles SET source='manual', version=version+1, task=NULL WHERE id=?",
      id,
    );
  }
  reserve(
    id: string,
    taskId: string,
    automatic: boolean,
    expectedVersion = 0,
  ): { version: number } | { rejected: string } {
    const old = this.query<{ version: number }>(
      'SELECT version FROM title_reservations WHERE taskId=? AND conversationId=?',
      taskId,
      id,
    ).toArray()[0];
    if (old)
      return old.version && this.isCurrent(id, taskId, old.version)
        ? { version: old.version }
        : { rejected: '标题已修改或任务已结束' };
    this.create(id, 'manual');
    const row = this.current(id)!,
      task = row.task ? (JSON.parse(row.task) as TitleTaskInfo) : null;
    const blocked =
      (expectedVersion > 0 && row.version !== expectedVersion) ||
      (automatic && row.source !== 'fallback') ||
      (task && ['queued', 'running'].includes(task.status));
    this.query(
      'INSERT INTO title_reservations VALUES (?, ?, ?)',
      taskId,
      id,
      blocked ? 0 : row.version,
    );
    if (blocked) return { rejected: '标题已命名或正在生成' };
    this.query(
      'UPDATE conversation_titles SET task=? WHERE id=?',
      JSON.stringify({ id: taskId, status: 'queued' }),
      id,
    );
    return { version: row.version };
  }
  isCurrent(id: string, taskId: string, version: number) {
    const row = this.current(id),
      task = row?.task ? (JSON.parse(row.task) as TitleTaskInfo) : null;
    return Boolean(
      row &&
      row.version === version &&
      task?.id === taskId &&
      ['queued', 'running'].includes(task.status),
    );
  }
  running(id: string, taskId: string, version: number) {
    if (!this.isCurrent(id, taskId, version)) return false;
    this.query(
      'UPDATE conversation_titles SET task=? WHERE id=?',
      JSON.stringify({ id: taskId, status: 'running' }),
      id,
    );
    return true;
  }
  finish(id: string, taskId: string, version: number, title: string | null, error?: string) {
    if (!this.isCurrent(id, taskId, version)) {
      const row = this.current(id),
        task = row?.task ? (JSON.parse(row.task) as TitleTaskInfo) : null;
      // A lost RPC acknowledgement can repeat result delivery, never the paid request.
      return Boolean(
        task?.id === taskId &&
        task.status === (title ? 'completed' : 'failed') &&
        row?.version === version + Number(Boolean(title)),
      );
    }
    const task: TitleTaskInfo = {
      id: taskId,
      status: title ? 'completed' : 'failed',
      ...(error ? { error } : {}),
    };
    if (title) {
      this.query('UPDATE conversations SET title=? WHERE id=?', cleanTitle(title), id);
      this.query(
        "UPDATE conversation_titles SET source='ai',version=version+1,task=? WHERE id=?",
        JSON.stringify(task),
        id,
      );
    } else this.query('UPDATE conversation_titles SET task=? WHERE id=?', JSON.stringify(task), id);
    return true;
  }
}
