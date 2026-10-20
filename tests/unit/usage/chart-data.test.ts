import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonRows, metricValue } from '../../../src/features/usage/chart-data';
import type { UsageGroup } from '../../../shared/usage/types';
import { emptyTotals } from '../../../worker/usage/aggregate';

const group = (key: string, change: Partial<UsageGroup> = {}): UsageGroup => ({
  ...emptyTotals(),
  key,
  label: key,
  ...change,
});

test('comparison ranking retains exact monetary order, combines only the selected currency and never fills unknown prices with zero', () => {
  const rows = Array.from({ length: 11 }, (_, index) =>
    group(`provider-${index}`, {
      requests: index,
      currencies: { USD: (9007199254740993n + BigInt(index)).toString(), CNY: '1' },
    }),
  );
  const unknown = group('unknown', { requests: 500, unpriced: 500 });
  const otherCurrency = group('cny-only', { currencies: { CNY: '999999999999999999' } });
  const result = comparisonRows([...rows, unknown, otherCurrency], 'USD', 'Other');
  assert.equal(result.length, 9);
  assert.equal(result[0].key, 'provider-10');
  assert.equal(result[0].amount, '9007199254741003');
  assert.deepEqual(
    result.slice(0, 8).map((row) => row.key),
    rows
      .slice(3)
      .reverse()
      .map((row) => row.key),
  );
  assert.equal(result.at(-1)!.amount, (9007199254740993n * 3n + 3n).toString());
  assert.equal(result.at(-1)!.label, 'Other');
  assert.equal(metricValue(unknown, 'USD'), null);
  assert.equal(metricValue(otherCurrency, 'USD'), null);
  assert.equal(metricValue(group('free', { currencies: { USD: '0' } }), 'USD'), 0);
  assert.equal(rows[0].key, 'provider-0');
});

test('changing the comparison metric reorders existing groups and includes input and output tokens', () => {
  const rows = [
    group('many-requests', { requests: 10, inputTokens: 1, outputTokens: 2 }),
    group('many-tokens', { requests: 1, inputTokens: 100, outputTokens: 200 }),
  ];
  assert.equal(comparisonRows(rows, 'requests', 'Other')[0].key, 'many-requests');
  const result = comparisonRows(rows, 'tokens', 'Other');
  assert.equal(result[0].key, 'many-tokens');
  assert.equal(result[0].value, 300);
  assert.equal(result[1].value, 3);
});
