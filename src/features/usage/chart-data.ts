import { CURRENCY_SCALE } from '../../../shared/usage/pricing';
import type { UsageGroup } from '../../../shared/usage/types';

export function chartCurrencies(rows: UsageGroup[]) {
  return [...new Set(rows.flatMap((row) => Object.keys(row.currencies)))].sort();
}

/** Keep the integer amount for sorting, aggregation and tooltips; only plots use Number. */
function metricAmount(row: UsageGroup, metric: string): bigint | null {
  if (metric === 'requests') return BigInt(row.requests);
  if (metric === 'tokens') return BigInt(row.inputTokens) + BigInt(row.outputTokens);
  const amount = row.currencies[metric];
  return amount === undefined ? null : BigInt(amount);
}

export function metricValue(row: UsageGroup, metric: string) {
  const amount = metricAmount(row, metric);
  return amount === null
    ? null
    : Number(amount) / (metric === 'requests' || metric === 'tokens' ? 1 : Number(CURRENCY_SCALE));
}

export interface ComparisonRow {
  key: string;
  label: string;
  amount: string;
  value: number;
  unpriced: number;
}

export function comparisonRows(rows: UsageGroup[], metric: string, otherLabel: string) {
  const ranked = rows.flatMap((row) => {
    const amount = metricAmount(row, metric);
    return amount === null ? [] : [{ row, amount }];
  });
  ranked.sort((a, b) =>
    a.amount === b.amount ? a.row.key.localeCompare(b.row.key) : a.amount > b.amount ? -1 : 1,
  );
  const result: ComparisonRow[] = ranked.slice(0, 8).map(({ row, amount }) => ({
    key: row.key,
    label: row.label,
    amount: amount.toString(),
    value: metricValue(row, metric)!,
    unpriced: row.unpriced,
  }));
  const remaining = ranked.slice(8);
  if (remaining.length) {
    const amount = remaining.reduce((total, entry) => total + entry.amount, 0n);
    result.push({
      key: 'other',
      label: otherLabel,
      amount: amount.toString(),
      value:
        Number(amount) /
        (metric === 'requests' || metric === 'tokens' ? 1 : Number(CURRENCY_SCALE)),
      unpriced: remaining.reduce((total, entry) => total + entry.row.unpriced, 0),
    });
  }
  return result;
}
