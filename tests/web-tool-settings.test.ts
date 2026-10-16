import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebToolSettings } from '../worker/web-tools/settings';
import type { SqlQuery } from '../worker/generation/metrics';

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let now = Date.UTC(2026, 9, 15, 23, 59);
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(sql: string, ...args: SqlStorageValue[]) => {
    const rows = db.prepare(sql).all(...args as (string | number | null)[]) as T[];
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, *[Symbol.iterator]() { yield* rows; } };
  };
  const read = () => new WebToolSettings(query, () => now), store = read();
  const write = <T>(fn: () => T) => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  return { db, store, read, write, advance: (ms: number) => { now += ms; } };
}
const input = { provider: 'tavily', apiKey: 'tvly-private-setting', dailyLimit: 20 };
const id = (value: number) => value.toString(16).padStart(64, '0');

test('service settings start unconfigured, never expose a key by default, and retain or explicitly clear credentials', (t) => {
  const { store, read, write } = setup(t);
  assert.deepEqual(store.settings(), { provider: 'tavily', hasApiKey: false, dailyLimit: 20, usedToday: 0 }); assert.equal(store.config(), undefined);
  write(() => store.save(input)); assert.doesNotMatch(JSON.stringify(store.settings()), /tvly-private/);
  assert.equal(read().config()?.apiKey, input.apiKey); assert.equal(read().key(), input.apiKey);
  write(() => store.save({ provider: 'tavily', dailyLimit: 5 })); assert.equal(store.key(), input.apiKey);
  write(() => store.save({ provider: 'tavily', dailyLimit: 5, apiKey: '' })); assert.equal(read().config(), undefined);
});

test('unknown endpoints, credentials with whitespace/control characters and invalid ceilings fail without changing saved settings', (t) => {
  const { store, write } = setup(t); write(() => store.save(input));
  for (const value of [{ ...input, baseUrl: 'https://evil.example/' }, { ...input, provider: 'other' }, { ...input, apiKey: 'key\r\nother' },
    { ...input, apiKey: 'key other' }, { ...input, apiKey: 'a'.repeat(4097) }, { ...input, dailyLimit: 0 }, { ...input, dailyLimit: 1001 }, { ...input, dailyLimit: 1.5 }]) assert.throws(() => write(() => store.save(value)), /设置无效/);
  assert.equal(store.key(), input.apiKey); assert.equal(store.settings().dailyLimit, 20);
});

test('daily attempts deduplicate across restart, respect accepted and lowered global limits, and survive failed/unknown external outcomes', (t) => {
  const { store, read, write } = setup(t); write(() => store.save(input));
  assert.deepEqual(write(() => store.claim(id(1), 1)), { allowed: true });
  assert.deepEqual(write(() => read().claim(id(1), 1)), { allowed: true }); assert.equal(read().settings().usedToday, 1);
  assert.ok('error' in write(() => store.claim(id(2), 1)));
  write(() => store.save({ ...input, dailyLimit: 1 })); assert.ok('error' in write(() => store.claim(id(2), 20)));
  assert.equal(store.settings().usedToday, 1);
  write(() => store.save({ ...input, dailyLimit: 2 })); assert.deepEqual(write(() => store.claim(id(2), 20)), { allowed: true });
  assert.ok('error' in write(() => store.claim(id(3), 20))); assert.equal(read().settings().usedToday, 2);
});

test('UTC rollover resets availability, retains the previous day for duplicate claims, and bounds ledger history', (t) => {
  const { store, db, write, advance } = setup(t); write(() => store.save(input));
  write(() => store.claim(id(1), 1)); advance(120_000);
  assert.equal(store.settings().usedToday, 0); write(() => store.claim(id(1), 1)); assert.equal(store.settings().usedToday, 0);
  write(() => store.claim(id(2), 1)); assert.equal(store.settings().usedToday, 1);
  advance(86_400_000); write(() => store.claim(id(3), 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM web_tool_requests').get()!.count, 2);
});

test('invalid claims and rolled-back reservations do not charge capacity', (t) => {
  const { store, write } = setup(t);
  assert.throws(() => write(() => store.claim('not-a-digest', 20)), /预算/);
  assert.throws(() => write(() => store.claim(id(1), Infinity)), /预算/);
  assert.throws(() => write(() => { store.claim(id(1), 20); throw new Error('rollback'); }), /rollback/);
  assert.equal(store.settings().usedToday, 0);
});
