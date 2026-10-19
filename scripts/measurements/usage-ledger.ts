// Synthetic local storage measurement. No network, credentials, or real conversations.
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { UsageAttempt } from '../../shared/usage/types';
import type { SqlQuery } from '../../worker/generation/metrics';
import { USAGE_SCHEMA } from '../../worker/usage/schema';
import { UsageLedger } from '../../worker/usage/store';

const db = new DatabaseSync(':memory:');
db.exec(USAGE_SCHEMA);
const allocated = () =>
  Number(db.prepare('PRAGMA page_count').get()!.page_count) *
  Number(db.prepare('PRAGMA page_size').get()!.page_size);
const empty = allocated();
let statements = 0,
  rowsReturned = 0,
  changedRows = 0;
const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
  sql: string,
  ...args: SqlStorageValue[]
) => {
  statements++;
  const statement = db.prepare(sql);
  const rows = statement.columns().length
    ? (statement.all(...(args as SQLInputValue[])) as T[])
    : [];
  if (!statement.columns().length)
    changedRows += Number(statement.run(...(args as SQLInputValue[])).changes);
  rowsReturned += rows.length;
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error('Expected one row');
      return rows[0];
    },
    *[Symbol.iterator]() {
      yield* rows;
    },
  };
};
const ledger = new UsageLedger(query),
  count = 1000,
  started = performance.now();
db.exec('BEGIN');
for (let index = 0; index < count; index++) {
  const attempt: UsageAttempt = {
    id: `request-${index}`,
    version: 0,
    conversationId: 'synthetic',
    messageId: `answer-${index}`,
    taskId: `task-${index}`,
    kind: 'chat',
    answer: true,
    providerId: `provider-${index % 3}`,
    providerName: 'Synthetic provider',
    protocol: 'openai-chat',
    model: `model-${index % 10}`,
    modelName: 'Synthetic model',
    startedAt: Date.UTC(2026, 9, 19) + index * 60_000,
    endedAt: null,
    status: 'running',
    usage: {},
    usageIsFinal: false,
    price: {
      id: 'synthetic-price',
      providerId: `provider-${index % 3}`,
      model: `model-${index % 10}`,
      currency: 'CNY',
      input: '2',
      output: '8',
      cacheRead: '0.2',
      cacheWrite: null,
      perRequest: null,
      source: '',
      effectiveFrom: 0,
    },
  };
  ledger.record(attempt);
  ledger.record({
    ...attempt,
    version: 1,
    endedAt: attempt.startedAt + 5000,
    status: 'completed',
    usage: { inputTokens: 1000, cachedInputTokens: 300, outputTokens: 200, reasoningTokens: 50 },
    usageIsFinal: true,
    firstTokenMs: 500,
  });
}
db.exec('COMMIT');
const result = {
  requests: count,
  localDurationMs: Math.round(performance.now() - started),
  emptyBytes: empty,
  allocatedBytes: allocated(),
  addedBytes: allocated() - empty,
  sqlStatements: statements,
  rowsReturned,
  logicalChangedRows: changedRows,
  disclaimer:
    'Local SQLite only. Changed rows exclude index maintenance; returned rows are not rows scanned. Neither is a Cloudflare billing metric. No Worker/DO CPU or RPC assertion.',
};
console.log(JSON.stringify(result, null, 2));
db.close();
