import * as v from 'valibot';
import type { StreamState, StreamUsage } from './provider-stream';
import { contextEstimateSchema, type ContextEstimate } from '../conversation/context-budget';

export interface GenerationTiming {
  queueMs?: number;
  firstTokenMs?: number;
  durationMs?: number;
}
export interface GenerationResult {
  finishReason?: StreamState['finishReason'];
  usage: StreamUsage;
  usageIsFinal: boolean;
  timing?: GenerationTiming;
  context?: ContextEstimate;
}
export function addGenerationUsage(
  previous: Pick<GenerationResult, 'usage' | 'usageIsFinal'> | undefined,
  current: Pick<GenerationResult, 'usage' | 'usageIsFinal'>,
): Pick<GenerationResult, 'usage' | 'usageIsFinal'> {
  const usage = { ...previous?.usage };
  let usageIsFinal = current.usageIsFinal && (previous?.usageIsFinal ?? true);
  if (
    previous &&
    [...new Set([...Object.keys(previous.usage), ...Object.keys(current.usage)])].some((field) => {
      const key = field as keyof StreamUsage;
      return (previous.usage[key] === undefined) !== (current.usage[key] === undefined);
    })
  )
    usageIsFinal = false;
  for (const key of Object.keys(current.usage) as (keyof StreamUsage)[]) {
    const value = current.usage[key];
    if (value === undefined) continue;
    const total = (usage[key] ?? 0) + value;
    if (Number.isSafeInteger(total)) usage[key] = total;
    else {
      delete usage[key];
      usageIsFinal = false;
    }
  }
  return { usage, usageIsFinal };
}
const count = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
);
export const generationSchema = v.strictObject({
  finishReason: v.optional(v.picklist(['stop', 'length', 'other'])),
  usage: v.strictObject({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cachedInputTokens: count,
    cacheWriteInputTokens: count,
    reasoningTokens: count,
    uncachedInputTokens: count,
    textOutputTokens: count,
    toolInputTokens: count,
  }),
  usageIsFinal: v.boolean(),
  timing: v.optional(v.strictObject({ queueMs: count, firstTokenMs: count, durationMs: count })),
  context: v.optional(contextEstimateSchema),
});
