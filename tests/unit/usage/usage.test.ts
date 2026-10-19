import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as v from 'valibot';
import { decimalMicros, estimateCost, formatAmount } from '../../../shared/usage/pricing';
import { priceInputSchema, type UsageAttempt, type UsagePrice } from '../../../shared/usage/types';
import { USAGE_OUTBOX_SCHEMA, USAGE_SCHEMA } from '../../../worker/usage/schema';
import { UsageLedger } from '../../../worker/usage/store';
import { UsageOutbox } from '../../../worker/usage/outbox';
import { UsageAccounting, modelIdentity } from '../../../worker/usage/accounting';
import type { Env } from '../../../worker/http/env';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { cleanIncompleteUsage } from '../../../scripts/operations/clean-usage';
import { localSnapshot, restoreSnapshot } from '../../../scripts/operations/storage-snapshot';
import { decodeValue } from '../../../scripts/operations/storage-protocol';

const price: UsagePrice = {
  id: 'price1',
  providerId: 'supplier1',
  model: 'same-model',
  currency: 'CNY',
  input: '2',
  output: '8',
  cacheRead: '0.2',
  cacheWrite: null,
  perRequest: null,
  source: '',
  effectiveFrom: 0,
};
const attempt = (change: Partial<UsageAttempt> = {}): UsageAttempt => ({
  id: 'attempt1',
  version: 1,
  conversationId: 'chat1',
  messageId: 'message1',
  taskId: 'task1',
  kind: 'chat',
  answer: true,
  providerId: 'supplier1',
  providerName: '供应商一',
  protocol: 'openai-chat',
  model: 'same-model',
  modelName: '相同模型',
  startedAt: Date.UTC(2026, 9, 19, 3),
  endedAt: Date.UTC(2026, 9, 19, 3) + 1000,
  status: 'completed',
  usage: { inputTokens: 1000, cachedInputTokens: 300, outputTokens: 200, reasoningTokens: 50 },
  usageIsFinal: true,
  price,
  ...change,
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(USAGE_SCHEMA + USAGE_OUTBOX_SCHEMA);
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  let now = 1000;
  return {
    db,
    query,
    ledger: new UsageLedger(query, () => now),
    outbox: new UsageOutbox(query, () => now),
    tick: (value: number) => {
      now = value;
    },
  };
}
test('accounting chooses manual prices before endpoint defaults, snapshots them once, and leaves lookup failures unpriced', async () => {
  const s = fixture();
  try {
    let configured: UsagePrice | null = null,
      fail = false;
    const accounting = new UsageAccounting(
      s.query,
      {
        USAGE: {
          getByName: () => ({
            price: async () => {
              if (fail) throw new Error('unavailable');
              return configured;
            },
          }),
        },
      } as unknown as Pick<Env, 'USAGE'>,
      async () => {},
    );
    const model = modelIdentity({
      provider: 'openai-chat',
      providerId: 'instance',
      baseUrl: 'https://api.deepseek.com/',
      model: 'deepseek-flash',
      systemPrompt: '',
      maxOutputTokens: null,
    });
    const start = (id: string) =>
      accounting.start(
        { id, taskId: id, conversationId: null, messageId: null, kind: 'chat' },
        model,
      );
    await start('default');
    assert.equal(accounting.get('default')?.price?.currency, 'USD');
    assert.equal(Object.hasOwn(accounting.get('default')!, 'baseUrl'), false);
    configured = { ...price, providerId: 'instance', model: model.model, input: '0' };
    await start('manual');
    assert.equal(accounting.get('manual')?.price?.id, price.id);
    assert.equal(accounting.get('manual')?.price?.input, '0');
    assert.equal(accounting.get('default')?.price?.currency, 'USD');
    fail = true;
    await start('outage');
    assert.equal(accounting.get('outage')?.price, null);
  } finally {
    s.db.close();
  }
});
test('fixed decimal pricing excludes cache and reasoning subsets from double billing', () => {
  assert.deepEqual(estimateCost(attempt().usage, true, price, 'chat'), {
    currency: 'CNY',
    amount: '3060000000',
    state: 'priced',
  });
  assert.equal(formatAmount('3060000000'), '0.003060');
  assert.equal(formatAmount('999999999999'), '1.000000');
  assert.equal(formatAmount('400000000000', 0), '0');
  assert.equal(formatAmount('500000000000', 0), '1');
  assert.equal(decimalMicros('0.000001'), 1n);
  assert.equal(
    estimateCost(
      { inputTokens: 1, outputTokens: 0 },
      true,
      { ...price, input: '0.000001', cacheRead: null },
      'chat',
    ).amount,
    '1',
  );
});
test('unknown, partial, zero and contradictory usage remain distinct', () => {
  assert.equal(estimateCost({}, false, null, 'chat').state, 'unpriced');
  assert.equal(estimateCost({}, false, price, 'chat').amount, null);
  assert.equal(
    estimateCost({ inputTokens: 100, cachedInputTokens: 300 }, true, price, 'chat').state,
    'invalid',
  );
  assert.equal(
    estimateCost({ outputTokens: 2, reasoningTokens: 3 }, true, price, 'chat').state,
    'invalid',
  );
  assert.equal(estimateCost({ inputTokens: -1 }, true, price, 'chat').state, 'invalid');
  assert.equal(estimateCost({ outputTokens: 1 }, false, price, 'chat').state, 'partial');
  assert.equal(
    estimateCost(
      { inputTokens: 0, outputTokens: 0 },
      true,
      { ...price, cacheRead: null, input: '0', output: '0' },
      'chat',
    ).state,
    'priced',
  );
  // A missing differentiated cache count must not be assumed to be zero.
  assert.deepEqual(estimateCost({ inputTokens: 1000, outputTokens: 200 }, true, price, 'chat'), {
    currency: 'CNY',
    amount: '1600000000',
    state: 'partial',
  });
  assert.equal(
    estimateCost({}, true, { ...price, perRequest: '0.01' }, 'web_search').amount,
    '10000000000',
  );
  for (const invalid of ['-1', 'NaN', '1e6', '0.0000001', '9999999999', ' 1', '01']) {
    assert.throws(() => decimalMicros(invalid));
    assert.equal(
      v.safeParse(priceInputSchema, {
        ...price,
        id: undefined,
        effectiveFrom: undefined,
        input: invalid,
      }).success,
      false,
    );
  }
});
test('ledger deduplicates terminal replay, corrects start aggregates and preserves fixed historical prices', () => {
  const s = fixture();
  try {
    s.ledger.record(
      attempt({ version: 0, status: 'running', endedAt: null, usage: {}, usageIsFinal: false }),
    );
    s.ledger.record(attempt());
    s.ledger.record(attempt());
    s.ledger.record(attempt({ version: 0, status: 'running', usage: {} }));
    assert.equal(s.ledger.report({}).totals.requests, 1);
    assert.equal(s.ledger.report({}).totals.completed, 1);
    assert.equal(s.ledger.report({}).totals.answers, 1);
    const input = { ...price };
    delete (input as Partial<UsagePrice>).id;
    delete (input as Partial<UsagePrice>).effectiveFrom;
    s.ledger.savePrice({ ...input, input: '100' });
    assert.equal(s.ledger.get('attempt1')?.price?.input, '2');
    assert.equal(s.ledger.report({}).totals.currencies.CNY, '3060000000');
    assert.throws(
      () => s.ledger.record(attempt({ version: 2, providerId: 'another' })),
      /身份冲突/,
    );
  } finally {
    s.db.close();
  }
});
test('supplier instances, currencies and auxiliary calls are independently aggregated and paginated', () => {
  const s = fixture();
  try {
    s.ledger.record(attempt());
    s.ledger.record(
      attempt({
        id: 'attempt2',
        kind: 'title',
        answer: false,
        providerId: 'supplier2',
        providerName: '供应商二',
        price: { ...price, providerId: 'supplier2', currency: 'USD' },
      }),
    );
    s.ledger.record(
      attempt({ id: 'attempt3', kind: 'web_search', answer: false, usage: {}, price: null }),
    );
    const report = s.ledger.report({});
    assert.equal(report.totals.requests, 3);
    assert.equal(report.totals.modelRequests, 2);
    assert.equal(report.totals.answers, 1);
    assert.equal(report.totals.unpriced, 1);
    assert.deepEqual(report.totals.currencies, { CNY: '3060000000', USD: '3060000000' });
    assert.equal(report.models.length, 2);
    assert.equal(s.ledger.report({ providerId: 'supplier2' }).totals.requests, 1);
    const first = s.ledger.page({ limit: 1 });
    const second = s.ledger.page({ limit: 1, cursor: first.cursor! });
    const third = s.ledger.page({ limit: 1, cursor: second.cursor! });
    assert.equal(new Set([first.records[0].id, second.records[0].id, third.records[0].id]).size, 3);
    assert.equal(third.cursor, null);
    assert.throws(() => s.ledger.page({ cursor: 'invalid' }));
  } finally {
    s.db.close();
  }
});
test('hour rollups retain exact range and local date boundaries, including fractional timezone offsets', () => {
  const s = fixture();
  try {
    for (const [id, minutes] of [
      ['a', 5],
      ['b', 20],
      ['c', 35],
      ['d', 50],
    ] as const)
      s.ledger.record(attempt({ id, startedAt: Date.UTC(2026, 9, 19, 18, minutes) }));
    const from = Date.UTC(2026, 9, 19, 18, 10),
      to = Date.UTC(2026, 9, 19, 18, 40);
    const report = s.ledger.report({ from, to }, 'Asia/Kolkata');
    assert.equal(report.totals.requests, 2);
    assert.deepEqual(
      report.trend.map((group) => [group.key, group.requests]),
      [
        ['2026-10-19', 1],
        ['2026-10-20', 1],
      ],
    );
    assert.equal(s.ledger.report({}, 'Asia/Shanghai').trend[0].key, '2026-10-20');
    assert.equal(s.ledger.report({ to: from }).totals.requests, 1);
  } finally {
    s.db.close();
  }
});
test('hourly trends distinguish repeated DST hours and retain gaps between requests', () => {
  const s = fixture();
  try {
    for (const [id, hour] of [
      ['a', 5],
      ['b', 6],
      ['c', 10],
    ] as const)
      s.ledger.record(attempt({ id, startedAt: Date.UTC(2026, 10, 1, hour, 10) }));
    const trend = s.ledger.report({}, 'America/New_York', true).trend;
    assert.equal(trend.length, 3);
    assert.match(trend[0].label, /01.*GMT-04:00/);
    assert.match(trend[1].label, /01.*GMT-05:00/);
    assert.equal(trend[1].at! - trend[0].at!, 3_600_000);
    assert.equal(trend[2].at! - trend[1].at!, 4 * 3_600_000);
  } finally {
    s.db.close();
  }
});
test('offline usage cleanup preserves complete records, running requests and prices, and rebuilds reproducible aggregates', () => {
  const s = fixture(),
    copy = new DatabaseSync(':memory:');
  try {
    s.db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,1)',
    );
    const { id: _id, effectiveFrom: _time, ...input } = price;
    s.ledger.savePrice(input);
    s.ledger.record(attempt());
    s.ledger.record(attempt({ id: 'corrected' }));
    const corrected = {
      ...s.ledger.get('corrected')!,
      correction: { amount: '999', reason: 'old', at: 1 },
    };
    s.query(
      'UPDATE usage_attempts SET payload=? WHERE id=?',
      JSON.stringify(corrected),
      'corrected',
    );
    s.ledger.record(attempt({ id: 'unpriced', price: null }));
    s.ledger.record(attempt({ id: 'unfinished', usageIsFinal: false }));
    s.ledger.record(attempt({ id: 'partial', usage: { inputTokens: 1000 } }));
    s.ledger.record(
      attempt({ id: 'invalid', usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 } }),
    );
    s.ledger.record(
      attempt({
        id: 'running',
        status: 'running',
        endedAt: null,
        usage: {},
        usageIsFinal: false,
        price: null,
      }),
    );
    const before = localSnapshot(s.db, 'usage'),
      prices = s.ledger.prices();
    restoreSnapshot(copy, before);
    const result = cleanIncompleteUsage(s.db);
    assert.deepEqual(result.counts, { before: 7, removed: 4, retained: 3, correctionsRemoved: 1 });
    assert.deepEqual(s.ledger.prices(), prices);
    assert.equal(s.ledger.get('attempt1')?.cost.amount, '3060000000');
    assert.equal(Object.hasOwn(s.ledger.get('corrected')!, 'correction'), false);
    assert.equal(s.ledger.get('running')?.status, 'running');
    assert.deepEqual(s.ledger.report({}).totals, {
      ...s.ledger.report({}).totals,
      requests: 3,
      incomplete: 1,
      unpriced: 1,
      currencies: { CNY: '6120000000' },
    });
    for (const { sql, args } of result.statements)
      copy.prepare(sql).run(...(args.map(decodeValue) as (string | number | null)[]));
    assert.deepEqual(localSnapshot(copy, 'usage'), localSnapshot(s.db, 'usage'));
    assert.equal(cleanIncompleteUsage(s.db).counts.removed, 0);
  } finally {
    s.db.close();
    copy.close();
  }
});
test('offline usage cleanup rolls back deletions and rollups on corrupt historical data', () => {
  const s = fixture();
  try {
    s.db.exec(
      'CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,1)',
    );
    s.ledger.record(attempt({ id: 'a-unpriced', price: null }));
    s.ledger.record(attempt({ id: 'z-corrupt' }));
    s.query('UPDATE usage_attempts SET payload=? WHERE id=?', '{', 'z-corrupt');
    const before = localSnapshot(s.db, 'usage');
    assert.throws(() => cleanIncompleteUsage(s.db));
    assert.deepEqual(localSnapshot(s.db, 'usage'), before);
  } finally {
    s.db.close();
  }
});
test('cancelled partial usage keeps known charges and bulk cursor pagination does not duplicate equal timestamps', () => {
  const s = fixture();
  try {
    s.ledger.record(
      attempt({
        status: 'cancelled',
        usage: { inputTokens: 1000 },
        usageIsFinal: false,
        price: { ...price, cacheRead: null },
      }),
    );
    const cancelled = s.ledger.get('attempt1')!;
    assert.equal(cancelled.cost.state, 'partial');
    assert.equal(cancelled.cost.amount, '2000000000');
    for (let i = 0; i < 237; i++) s.ledger.record(attempt({ id: `bulk-${i}` }));
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = s.ledger.page({ limit: 50, ...(cursor ? { cursor } : {}) });
      for (const record of page.records) {
        assert.equal(seen.has(record.id), false);
        seen.add(record.id);
      }
      cursor = page.cursor;
    } while (cursor);
    assert.equal(seen.size, 238);
    assert.equal(s.ledger.report({ status: 'cancelled' }).totals.requests, 1);
  } finally {
    s.db.close();
  }
});
test('durable outbox survives failed delivery and concurrent finalization without dropping or duplicating usage', async () => {
  const s = fixture();
  try {
    const {
      version: _v,
      price: _p,
      status: _s,
      usage: _u,
      usageIsFinal: _f,
      endedAt: _e,
      ...start
    } = attempt();
    s.outbox.begin(start, price);
    assert.throws(() => s.outbox.begin(start, price));
    await s.outbox.flush(async () => {
      throw new Error('network');
    });
    assert.equal(s.outbox.nextAlarm(), 2000);
    s.tick(2000);
    await s.outbox.flush(async (record) => {
      s.ledger.record(record);
      s.outbox.finish(record.id, {
        status: 'completed',
        usage: attempt().usage,
        usageIsFinal: true,
      });
    });
    assert.equal(s.outbox.get(start.id)?.status, 'completed');
    await s.outbox.flush(async (record) => s.ledger.record(record));
    assert.equal(s.outbox.get(start.id), undefined);
    assert.equal(s.ledger.report({}).totals.requests, 1);
    assert.equal(s.ledger.report({}).totals.currencies.CNY, '3060000000');
  } finally {
    s.db.close();
  }
});
test('interrupted supplier attempts become unknown and do not reopen a supplier connection', async () => {
  const s = fixture();
  try {
    const {
      version: _v,
      price: _p,
      status: _s,
      usage: _u,
      usageIsFinal: _f,
      endedAt: _e,
      ...start
    } = attempt();
    s.outbox.begin(start, price);
    await s.outbox.flush(async (record) => s.ledger.record(record));
    assert.equal(s.outbox.nextAlarm(), null);
    s.outbox.recover(new Set());
    await s.outbox.flush(async (record) => s.ledger.record(record));
    assert.equal(s.ledger.get(start.id)?.status, 'unknown');
    assert.equal(s.ledger.get(start.id)?.cost.amount, null);
    assert.equal(s.ledger.report({}).totals.requests, 1);
  } finally {
    s.db.close();
  }
});
