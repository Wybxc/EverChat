import { AppError, problem } from '../../shared/errors/descriptor';
import type { UsageAttempt, UsagePrice } from '../../shared/usage/types';
import type { SqlQuery } from '../generation/metrics';

type Row = { id: string; payload: string; attempts: number } & Record<string, SqlStorageValue>;
export class UsageOutbox {
  private flushing = false;
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {}
  get(id: string): UsageAttempt | undefined {
    const row = this.query<Row>('SELECT * FROM usage_outbox WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  begin(
    attempt: Omit<
      UsageAttempt,
      'version' | 'price' | 'status' | 'usage' | 'usageIsFinal' | 'endedAt'
    >,
    price: UsagePrice | null,
  ) {
    if (this.get(attempt.id))
      throw new AppError(problem('USAGE_INVALID'), '不能重复发出已登记的供应商请求。');
    const record: UsageAttempt = {
      ...attempt,
      version: 0,
      price,
      status: 'running',
      usage: {},
      usageIsFinal: false,
      endedAt: null,
    };
    this.query(
      'INSERT INTO usage_outbox(id,payload,nextAt) VALUES (?,?,?)',
      record.id,
      JSON.stringify(record),
      this.now(),
    );
  }
  finish(
    id: string,
    result: Pick<UsageAttempt, 'status' | 'usage' | 'usageIsFinal'> &
      Partial<Pick<UsageAttempt, 'firstTokenMs' | 'httpStatus' | 'usageSources'>>,
  ) {
    const record = this.get(id);
    if (!record || record.status !== 'running') return;
    const completed: UsageAttempt = {
      ...record,
      ...result,
      version: record.version + 1,
      endedAt: this.now(),
    };
    this.query(
      'UPDATE usage_outbox SET payload=?,nextAt=?,attempts=0 WHERE id=?',
      JSON.stringify(completed),
      this.now(),
      id,
    );
  }
  recover(
    activeIds: Set<string>,
    checkpoint?: (record: UsageAttempt) => UsageAttempt['usage'] | undefined,
  ) {
    for (const row of this.query<Row>('SELECT * FROM usage_outbox').toArray()) {
      const record = JSON.parse(row.payload) as UsageAttempt;
      if (record.status === 'running' && !activeIds.has(record.id))
        this.finish(record.id, {
          status: 'unknown',
          usage: checkpoint?.(record) ?? record.usage,
          usageIsFinal: false,
        });
    }
  }
  nextAlarm() {
    return this.query<{ next: number | null }>('SELECT MIN(nextAt) AS next FROM usage_outbox').one()
      .next;
  }
  pending() {
    return this.query<Row>('SELECT * FROM usage_outbox').toArray();
  }
  restore(rows: Row[]) {
    for (const row of rows)
      this.query(
        'INSERT OR IGNORE INTO usage_outbox(id,payload,nextAt,attempts) VALUES (?,?,?,?)',
        row.id,
        row.payload,
        row.nextAt,
        row.attempts,
      );
  }
  async flush(publish: (attempt: UsageAttempt) => Promise<void>) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const row of this.query<Row>(
        'SELECT * FROM usage_outbox WHERE nextAt<=? ORDER BY nextAt LIMIT 8',
        this.now(),
      ).toArray()) {
        const record = JSON.parse(row.payload) as UsageAttempt;
        try {
          await publish(record);
          const current = this.get(row.id);
          // A completion may have been committed while the initial record was in flight.
          if (!current || current.version !== record.version) continue;
          if (record.status === 'running')
            this.query('UPDATE usage_outbox SET nextAt=NULL WHERE id=?', row.id);
          else this.query('DELETE FROM usage_outbox WHERE id=?', row.id);
        } catch {
          const current = this.get(row.id);
          if (current?.version === record.version)
            this.query(
              'UPDATE usage_outbox SET attempts=attempts+1,nextAt=? WHERE id=?',
              this.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)),
              row.id,
            );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
