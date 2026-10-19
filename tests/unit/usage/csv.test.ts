import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell } from '../../../shared/usage/csv';
import { sdkUsage } from '../../../shared/usage/normalize';
import { estimateCost } from '../../../shared/usage/pricing';
import type { UsagePrice } from '../../../shared/usage/types';
test('CSV neutralizes formulas, leading whitespace and quote escapes', () => {
  for (const value of ['=SUM(1,2)', '+1', '-1', '@cmd', ' \t=1', '\r\n=1', '\tplain'])
    assert.ok(csvCell(value).startsWith('"\''), value);
  assert.equal(csvCell('普通,"名称"'), '"普通,""名称"""');
});
test('SDK inclusive usage and partial cache detail never double-bill or discard known input', () => {
  const usage = sdkUsage({
    inputTokens: { total: 1000, noCache: 700, cacheRead: 300, cacheWrite: undefined },
    outputTokens: { total: 200, text: 150, reasoning: 50 },
  });
  const price: UsagePrice = {
    id: 'p',
    providerId: 'p',
    model: 'm',
    currency: 'CNY',
    effectiveFrom: 0,
    source: '',
    input: '2',
    output: '8',
    cacheRead: '0.2',
    cacheWrite: null,
    perRequest: null,
  };
  assert.equal(estimateCost(usage, true, price, 'probe').amount, '3060000000');
  assert.equal(
    estimateCost(
      { inputTokens: 1000, uncachedInputTokens: 700, outputTokens: 200 },
      true,
      price,
      'probe',
    ).amount,
    '3000000000',
  );
  assert.equal(
    estimateCost(
      { inputTokens: 1000, uncachedInputTokens: 700, outputTokens: 200 },
      true,
      price,
      'probe',
    ).state,
    'partial',
  );
  assert.equal(
    estimateCost(
      { inputTokens: 1000, uncachedInputTokens: 700, outputTokens: 200 },
      true,
      { ...price, cacheRead: '2.000000' },
      'chat',
    ).amount,
    '3600000000',
  );
});
