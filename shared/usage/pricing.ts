import { AppError, problem } from '../errors/descriptor';
import type { StreamUsage } from '../streaming/provider-stream';
import type { CostEstimate, UsageKind, UsagePrice } from './types';

export const CURRENCY_SCALE = 1_000_000_000_000n;
export function decimalMicros(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value))
    throw new AppError(problem('PRICING_INVALID'), '无效的价格。');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function formatAmount(amount: string, digits = 6): string {
  const number = BigInt(amount),
    places = Math.max(0, Math.min(12, digits));
  const rounded = (number + 10n ** BigInt(12 - places) / 2n) / 10n ** BigInt(12 - places);
  if (!places) return rounded.toString();
  return `${rounded / 10n ** BigInt(places)}.${(rounded % 10n ** BigInt(places)).toString().padStart(places, '0')}`;
}
const count = (value: number | undefined) =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0);

/** Cache and reasoning counters are subsets of normalized input/output, never extra totals. */
export function estimateCost(
  usage: StreamUsage,
  final: boolean,
  price: UsagePrice | null,
  kind: UsageKind,
): CostEstimate {
  if (!price) return { currency: null, amount: null, state: 'unpriced' };
  const unknown: CostEstimate = { currency: price.currency, amount: null, state: 'unpriced' };
  if (!Object.values(usage).every(count)) return { ...unknown, state: 'invalid' };
  let amount = 0n,
    known = false,
    missing = !final;
  const add = (tokens: number | undefined, rate: string | null) => {
    if (tokens === undefined) {
      missing = true;
      return;
    }
    if (tokens === 0) {
      known = true;
      return;
    }
    if (rate === null) {
      missing = true;
      return;
    }
    amount += BigInt(tokens) * decimalMicros(rate);
    known = true;
  };
  if (kind === 'web_search' || kind === 'read_webpage') {
    if (price.perRequest === null) return unknown;
    amount = decimalMicros(price.perRequest) * 1_000_000n;
    known = true;
  } else {
    const read = usage.cachedInputTokens,
      write = usage.cacheWriteInputTokens;
    if (usage.inputTokens !== undefined && (read ?? 0) + (write ?? 0) > usage.inputTokens)
      return { ...unknown, state: 'invalid' };
    if (
      usage.uncachedInputTokens !== undefined &&
      usage.inputTokens !== undefined &&
      (usage.uncachedInputTokens + (read ?? 0) + (write ?? 0) > usage.inputTokens ||
        (read !== undefined &&
          write !== undefined &&
          usage.uncachedInputTokens + read + write !== usage.inputTokens))
    )
      return { ...unknown, state: 'invalid' };
    // Missing cache counters may use input pricing only when no differential rate was configured.
    const different = (rate: string | null) =>
      rate !== null && (price.input === null || decimalMicros(rate) !== decimalMicros(price.input));
    if (
      (read === undefined && different(price.cacheRead)) ||
      (write === undefined && different(price.cacheWrite))
    ) {
      missing = true;
      // Known subsets are still calculable; do not charge the ambiguous remainder.
      if (usage.uncachedInputTokens !== undefined) add(usage.uncachedInputTokens, price.input);
      if (read !== undefined) add(read, price.cacheRead ?? price.input);
      if (write !== undefined) add(write, price.cacheWrite ?? price.input);
    } else {
      const ordinary =
        usage.inputTokens === undefined
          ? usage.uncachedInputTokens
          : usage.inputTokens - (read ?? 0) - (write ?? 0);
      add(ordinary, price.input);
      if (read !== undefined) add(read, price.cacheRead ?? price.input);
      if (write !== undefined) add(write, price.cacheWrite ?? price.input);
    }
    if (usage.outputTokens !== undefined && (usage.reasoningTokens ?? 0) > usage.outputTokens)
      return { ...unknown, state: 'invalid' };
    if (
      usage.outputTokens !== undefined &&
      (usage.textOutputTokens ?? 0) + (usage.reasoningTokens ?? 0) > usage.outputTokens
    )
      return { ...unknown, state: 'invalid' };
    if (price.reasoning != null && differentOutput(price.reasoning, price.output)) {
      if (usage.reasoningTokens === undefined) {
        missing = true;
        if (usage.textOutputTokens !== undefined) add(usage.textOutputTokens, price.output);
      } else {
        add(
          usage.outputTokens === undefined
            ? usage.textOutputTokens
            : usage.outputTokens - usage.reasoningTokens,
          price.output,
        );
        add(usage.reasoningTokens, price.reasoning);
      }
    } else add(usage.outputTokens, price.output);
    if (price.perRequest !== null) {
      amount += decimalMicros(price.perRequest) * 1_000_000n;
      known = true;
    }
  }
  return {
    currency: price.currency,
    amount: known ? amount.toString() : null,
    state: !known ? 'unpriced' : missing ? 'partial' : 'priced',
  };
}

function differentOutput(reasoning: string, output: string | null) {
  return output === null || decimalMicros(reasoning) !== decimalMicros(output);
}
