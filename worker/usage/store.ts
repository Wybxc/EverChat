import * as v from 'valibot';
import { AppError, problem } from '../../shared/errors/descriptor';
import { estimateCost } from '../../shared/usage/pricing';
import {
  priceInputSchema,
  type UsageAttempt,
  type UsageFilter,
  type UsageGroup,
  type UsagePrice,
  type UsagePriceInput,
  type UsageRecord,
  type UsageReport,
  type UsageTotals,
} from '../../shared/usage/types';
import type { SqlQuery } from '../generation/metrics';
import { addRecord, emptyTotals, mergeTotals } from './aggregate';

type PayloadRow = { payload: string } & Record<string, SqlStorageValue>;
type Rollup = { totals: UsageTotals; providerName: string; modelName: string };
const HOUR = 3_600_000;
function where(filter: UsageFilter, start = 'startedAt') {
  const conditions: string[] = [],
    args: SqlStorageValue[] = [];
  for (const [key, operator, value] of [
    [start, '>=', filter.from],
    [start, '<', filter.to],
    ['providerId', '=', filter.providerId],
    ['model', '=', filter.model],
    ['kind', '=', filter.kind],
    ['status', '=', filter.status],
  ] as const)
    if (value !== undefined) {
      conditions.push(`${key}${operator}?`);
      args.push(value);
    }
  return { clause: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', args };
}
export class UsageLedger {
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {}
  price(providerId: string, model: string, at = this.now()): UsagePrice | null {
    const row = this.query<PayloadRow>(
      'SELECT payload FROM usage_prices WHERE providerId=? AND model=? AND effectiveFrom<=? ORDER BY effectiveFrom DESC, rowid DESC LIMIT 1',
      providerId,
      model,
      at,
    ).toArray()[0];
    return row ? JSON.parse(row.payload) : null;
  }
  prices(): UsagePrice[] {
    return this.query<PayloadRow>(
      `SELECT payload FROM usage_prices AS p WHERE rowid=(
      SELECT rowid FROM usage_prices WHERE providerId=p.providerId AND model=p.model ORDER BY effectiveFrom DESC,rowid DESC LIMIT 1
    ) ORDER BY providerId,model`,
    )
      .toArray()
      .map((row) => JSON.parse(row.payload));
  }
  dimensions() {
    return this.query<PayloadRow>(
      `SELECT payload,MAX(startedAt) FROM usage_attempts GROUP BY providerId,model`,
    )
      .toArray()
      .map(({ payload }) => {
        const row = JSON.parse(payload) as UsageRecord;
        return {
          providerId: row.providerId,
          providerName: row.providerName,
          model: row.model,
          modelName: row.modelName,
        };
      });
  }
  savePrice(input: UsagePriceInput): UsagePrice {
    const value = v.parse(priceInputSchema, input);
    const price = { ...value, id: crypto.randomUUID(), effectiveFrom: this.now() };
    this.query(
      'INSERT INTO usage_prices VALUES (?,?,?,?,?)',
      price.id,
      price.providerId,
      price.model,
      price.effectiveFrom,
      JSON.stringify(price),
    );
    return price;
  }
  record(attempt: UsageAttempt) {
    const previous = this.get(attempt.id);
    if (
      previous &&
      (previous.startedAt !== attempt.startedAt ||
        previous.providerId !== attempt.providerId ||
        previous.model !== attempt.model ||
        previous.taskId !== attempt.taskId ||
        previous.conversationId !== attempt.conversationId ||
        previous.messageId !== attempt.messageId ||
        previous.kind !== attempt.kind ||
        previous.protocol !== attempt.protocol)
    )
      throw new AppError(problem('USAGE_INVALID'), '用量请求身份冲突。');
    if (previous && previous.version >= attempt.version) return;
    if (previous && previous.status !== 'running' && attempt.status === 'running') return;
    const record: UsageRecord = {
      ...attempt,
      cost: estimateCost(attempt.usage, attempt.usageIsFinal, attempt.price, attempt.kind),
    };
    if (previous) this.rollup(previous, -1);
    this.query(
      `INSERT INTO usage_attempts VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      version=excluded.version,status=excluded.status,payload=excluded.payload`,
      record.id,
      record.version,
      record.startedAt,
      record.providerId,
      record.model,
      record.kind,
      record.status,
      JSON.stringify(record),
      record.messageId,
    );
    this.rollup(record, 1);
  }
  get(id: string): UsageRecord | null {
    const row = this.query<PayloadRow>(
      'SELECT payload FROM usage_attempts WHERE id=?',
      id,
    ).toArray()[0];
    return row ? JSON.parse(row.payload) : null;
  }
  answer(messageId: string) {
    const totals = emptyTotals();
    for (const row of this.query<PayloadRow>(
      'SELECT payload FROM usage_attempts WHERE messageId=?',
      messageId,
    ).toArray())
      addRecord(totals, JSON.parse(row.payload));
    return totals;
  }
  private rollup(record: UsageRecord, direction: number) {
    const hour = Math.floor(record.startedAt / HOUR) * HOUR;
    const bucket = JSON.stringify([
      hour,
      record.providerId,
      record.model,
      record.kind,
      record.status,
    ]);
    const stored = this.query<PayloadRow>(
      'SELECT payload FROM usage_rollups WHERE bucket=?',
      bucket,
    ).toArray()[0];
    const value: Rollup = stored
      ? JSON.parse(stored.payload)
      : { totals: emptyTotals(), providerName: record.providerName, modelName: record.modelName };
    addRecord(value.totals, record, direction);
    if (!value.totals.requests) this.query('DELETE FROM usage_rollups WHERE bucket=?', bucket);
    else
      this.query(
        `INSERT INTO usage_rollups VALUES (?,?,?,?,?,?,?) ON CONFLICT(bucket) DO UPDATE SET payload=excluded.payload`,
        bucket,
        hour,
        record.providerId,
        record.model,
        record.kind,
        record.status,
        JSON.stringify(value),
      );
  }
  page(filter: UsageFilter) {
    const query = where(filter),
      limit = Math.max(1, Math.min(100, filter.limit ?? 25));
    if (filter.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(atob(filter.cursor));
      } catch {
        throw new AppError(problem('USAGE_INVALID'), '无效的分页位置。');
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !Number.isSafeInteger(cursor[0]) ||
        typeof cursor[1] !== 'string'
      )
        throw new AppError(problem('USAGE_INVALID'), '无效的分页位置。');
      query.clause += `${query.clause ? ' AND' : ' WHERE'} (startedAt<? OR (startedAt=? AND id<?))`;
      query.args.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.query<PayloadRow>(
      `SELECT payload FROM usage_attempts${query.clause} ORDER BY startedAt DESC,id DESC LIMIT ?`,
      ...query.args,
      limit + 1,
    )
      .toArray()
      .map((row) => JSON.parse(row.payload) as UsageRecord);
    const records = rows.slice(0, limit),
      last = records.at(-1);
    return {
      records,
      cursor: rows.length > limit && last ? btoa(JSON.stringify([last.startedAt, last.id])) : null,
    };
  }
  report(filter: UsageFilter, timeZone = 'UTC', hourly = false): UsageReport {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(hourly ? { hour: '2-digit', hourCycle: 'h23' } : {}),
      ...(hourly ? { timeZoneName: 'longOffset' } : {}),
    });
    const totals = emptyTotals(),
      providers = new Map<string, UsageGroup>(),
      models = new Map<string, UsageGroup>(),
      trend = new Map<string, UsageGroup>();
    const merge = (
      map: Map<string, UsageGroup>,
      key: string,
      label: string,
      values: UsageTotals,
      providerId: string,
      model: string,
    ) => {
      let group = map.get(key);
      if (!group) {
        group = { ...emptyTotals(), key, label, providerId, model };
        map.set(key, group);
      }
      mergeTotals(group, values);
    };
    const include = (value: Rollup, at: number, providerId: string, model: string) => {
      mergeTotals(totals, value.totals);
      merge(providers, providerId, value.providerName, value.totals, providerId, model);
      merge(
        models,
        JSON.stringify([providerId, model]),
        `${value.providerName} · ${value.modelName}`,
        value.totals,
        providerId,
        model,
      );
      const label = formatter.format(at).replaceAll('−', '-');
      merge(trend, label, label, value.totals, providerId, model);
      const group = trend.get(label)!;
      // Keep repeated local hours distinct at the autumn DST transition.
      if (hourly) {
        const parts = formatter.formatToParts(at);
        const field = (name: Intl.DateTimeFormatPartTypes) =>
          parts.find((p) => p.type === name)?.value;
        const offset = /GMT([+-])(\d{2}):(\d{2})/.exec(
          (field('timeZoneName') ?? '').replaceAll('−', '-'),
        );
        const offsetMs = offset
          ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000
          : 0;
        group.at =
          Date.UTC(
            Number(field('year')),
            Number(field('month')) - 1,
            Number(field('day')),
            Number(field('hour')),
          ) - offsetMs;
      } else group.at = Date.parse(label + 'T00:00:00Z');
    };
    const conditions = where({
      ...filter,
      from: filter.from === undefined ? undefined : Math.floor(filter.from / HOUR) * HOUR,
    });
    for (const bucket of this.query<
      PayloadRow & {
        startedAt: number;
        providerId: string;
        model: string;
        kind: UsageAttempt['kind'];
        status: UsageAttempt['status'];
      }
    >(`SELECT * FROM usage_rollups${conditions.clause} ORDER BY startedAt`, ...conditions.args)) {
      const start = bucket.startedAt,
        end = start + HOUR;
      if (
        (filter.from === undefined || start >= filter.from) &&
        (filter.to === undefined || end <= filter.to) &&
        formatter.format(start) === formatter.format(end - 1)
      ) {
        include(JSON.parse(bucket.payload), start, bucket.providerId, bucket.model);
      } else {
        // Only boundary hours need raw records: this also handles fractional-offset time zones and DST.
        const edge = where({
          ...filter,
          from: Math.max(filter.from ?? start, start),
          to: Math.min(filter.to ?? end, end),
          providerId: bucket.providerId,
          model: bucket.model,
          kind: bucket.kind,
          status: bucket.status,
        });
        for (const row of this.query<PayloadRow>(
          `SELECT payload FROM usage_attempts${edge.clause}`,
          ...edge.args,
        )) {
          const record = JSON.parse(row.payload) as UsageRecord,
            values = emptyTotals();
          addRecord(values, record);
          include(
            { totals: values, providerName: record.providerName, modelName: record.modelName },
            record.startedAt,
            record.providerId,
            record.model,
          );
        }
      }
    }
    const since = this.query<{ startedAt: number | null }>(
      'SELECT MIN(startedAt) AS startedAt FROM usage_attempts',
    ).one().startedAt;
    return {
      totals,
      providers: [...providers.values()],
      models: [...models.values()],
      trend: [...trend.values()].sort((a, b) => a.at! - b.at!),
      collectedSince: since,
    };
  }
}
