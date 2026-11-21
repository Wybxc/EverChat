import * as v from 'valibot';
import {
  SERVER_TOOL_KINDS,
  type ServerToolKind,
  type ServerToolVendor,
} from '../tools/server-tools';
import type { CostEstimate } from './types';

const quantity = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100_000));
export const serverToolUsageSchema = v.pipe(
  v.array(
    v.strictObject({
      tool: v.picklist(SERVER_TOOL_KINDS),
      unit: v.picklist(['call', 'query', 'image-query']),
      count: quantity,
      source: v.picklist(['reported', 'observed']),
      usdPerUnit: v.nullable(v.pipe(v.string(), v.regex(/^\d+(?:\.\d{1,6})?$/))),
    }),
  ),
  v.maxLength(12),
);
export type ServerToolUsage = v.InferOutput<typeof serverToolUsageSchema>[number];

// Standard API rates published for this catalog revision. Token charges are
// handled separately by the existing model usage ledger.
export function serverToolUnitRate(
  vendor: ServerToolVendor,
  tool: ServerToolKind,
): ServerToolUsage['usdPerUnit'] {
  if (vendor === 'deepseek') return '0';
  if (tool === 'web-search' && (vendor === 'openai' || vendor === 'anthropic')) return '0.01';
  if (vendor === 'anthropic' && tool === 'web-fetch') return '0';
  if (vendor === 'openai' && tool === 'file-search') return '0.0025';
  return null;
}

export function includeServerToolCost(
  model: CostEstimate,
  tools?: readonly ServerToolUsage[],
): CostEstimate {
  if (!tools?.length || model.state === 'invalid') return model;
  if (model.currency && model.currency !== 'USD')
    return { ...model, state: model.amount === null ? model.state : 'partial' };
  let extra = 0n,
    rateKnown = false,
    complete = model.state === 'priced';
  for (const tool of tools) {
    if (tool.usdPerUnit === null) {
      complete = false;
      continue;
    }
    rateKnown = true;
    const [whole, fraction = ''] = tool.usdPerUnit.split('.');
    extra += BigInt(whole + fraction.padEnd(12, '0')) * BigInt(tool.count);
  }
  if (model.amount === null && !rateKnown) return model;
  return {
    currency: 'USD',
    amount: (BigInt(model.amount ?? '0') + extra).toString(),
    state: complete ? 'priced' : 'partial',
  };
}
