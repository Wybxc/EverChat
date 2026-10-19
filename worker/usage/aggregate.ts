import type { UsageRecord, UsageTotals } from '../../shared/usage/types';
export const emptyTotals = (): UsageTotals => ({
  requests: 0,
  modelRequests: 0,
  answers: 0,
  completed: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheEligibleInputTokens: 0,
  cacheReportedReadTokens: 0,
  cacheWriteInputTokens: 0,
  incomplete: 0,
  unpriced: 0,
  currencies: {},
  durationMs: 0,
  durationSamples: 0,
  firstTokenMs: 0,
  firstTokenSamples: 0,
});
export function addRecord(totals: UsageTotals, record: UsageRecord, direction = 1) {
  totals.requests += direction;
  if (record.answer) totals.answers += direction;
  if (record.kind !== 'web_search' && record.kind !== 'read_webpage')
    totals.modelRequests += direction;
  if (record.status === 'completed') totals.completed += direction;
  if (!record.usageIsFinal) totals.incomplete += direction;
  if (record.cost.state !== 'priced') totals.unpriced += direction;
  if (record.usage.inputTokens !== undefined && record.usage.cachedInputTokens !== undefined) {
    totals.cacheEligibleInputTokens += record.usage.inputTokens * direction;
    totals.cacheReportedReadTokens += record.usage.cachedInputTokens * direction;
  }
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
  ] as const)
    totals[field] += (record.usage[field] ?? 0) * direction;
  const amount = record.cost.amount;
  if (amount !== null && record.cost.currency)
    totals.currencies[record.cost.currency] = (
      BigInt(totals.currencies[record.cost.currency] ?? '0') +
      BigInt(amount) * BigInt(direction)
    ).toString();
  if (record.endedAt !== null) {
    totals.durationMs += Math.max(0, record.endedAt - record.startedAt) * direction;
    totals.durationSamples += direction;
  }
  if (record.firstTokenMs !== undefined) {
    totals.firstTokenMs += record.firstTokenMs * direction;
    totals.firstTokenSamples += direction;
  }
}
export function mergeTotals(target: UsageTotals, source: UsageTotals) {
  for (const key of Object.keys(emptyTotals()) as (keyof UsageTotals)[]) {
    if (key === 'currencies') continue;
    target[key] += source[key];
  }
  for (const [currency, amount] of Object.entries(source.currencies))
    target.currencies[currency] = (
      BigInt(target.currencies[currency] ?? '0') + BigInt(amount)
    ).toString();
}
