import { MODEL_PRICE_SNAPSHOT, MODEL_PRICE_UPDATED_AT } from '../models/generated/prices';
import type { UsagePrice } from './types';

type Rates = Pick<UsagePrice, 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite'>;
export type ModelPriceCatalog = Record<string, Record<string, Rates>>;
const nativeEndpoints: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Prices belong to an endpoint and exact model ID, never just a model family name. */
function endpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null;
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:beta|alpha)?$/, '');
  } catch {
    return null;
  }
}
function rate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1e9)
    return null;
  // The ledger supports six decimal places. Do not turn a smaller positive price into free.
  const text = value.toFixed(6).replace(/\.?0+$/, '') || '0';
  return value > 0 && Number(text) === 0 ? null : text;
}

export function parsePriceCatalog(value: unknown): ModelPriceCatalog {
  const result: ModelPriceCatalog = {};
  for (const [vendor, raw] of Object.entries(object(value))) {
    const provider = object(raw);
    for (const [id, item] of Object.entries(object(provider.models))) {
      if (!/^[\w./:@+-]{1,200}$/.test(id) || ['__proto__', 'constructor'].includes(id)) continue;
      const model = object(item),
        api = object(model.provider).api ?? provider.api ?? nativeEndpoints[vendor];
      if (typeof api !== 'string') continue;
      const key = endpoint(api),
        cost = object(model.cost);
      if (
        !key ||
        (Array.isArray(object(model.modalities).output) &&
          !(object(model.modalities).output as unknown[]).includes('text'))
      )
        continue;
      const prices = {
        input: rate(cost.input),
        output: rate(cost.output),
        reasoning: rate(cost.reasoning),
        cacheRead: rate(cost.cache_read),
        cacheWrite: rate(cost.cache_write),
      };
      if (Object.values(prices).some((price) => price !== null)) (result[key] ??= {})[id] = prices;
    }
  }
  return result;
}

export function catalogPrice(
  providerId: string,
  model: string,
  baseUrl: string,
  catalog: ModelPriceCatalog = MODEL_PRICE_SNAPSHOT,
): UsagePrice | null {
  const key = endpoint(baseUrl),
    models = key ? catalog[key] : undefined,
    id = model.replace(/^models\//, '');
  const prices = models && Object.hasOwn(models, id) ? models[id] : null;
  if (!prices) return null;
  return {
    ...prices,
    id: `models.dev:${MODEL_PRICE_UPDATED_AT}:${providerId}:${id}`,
    providerId,
    model,
    currency: 'USD',
    perRequest: null,
    source: `models.dev · ${MODEL_PRICE_UPDATED_AT}`,
    effectiveFrom: Date.parse(MODEL_PRICE_UPDATED_AT),
  };
}
