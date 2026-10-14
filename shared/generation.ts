import * as v from 'valibot';
import type { StreamState, StreamUsage } from './provider-stream';
import { contextEstimateSchema, type ContextEstimate } from './context-budget';

export interface GenerationTiming { queueMs?: number; firstTokenMs?: number; durationMs?: number }
export interface GenerationResult {
  finishReason?: StreamState['finishReason']; usage: StreamUsage; usageIsFinal: boolean; timing?: GenerationTiming;
  context?: ContextEstimate;
}
const count = v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)));
export const generationSchema = v.strictObject({
  finishReason: v.optional(v.picklist(['stop', 'length', 'other'])),
  usage: v.strictObject({ inputTokens: count, outputTokens: count, totalTokens: count, cachedInputTokens: count,
    cacheWriteInputTokens: count, reasoningTokens: count, uncachedInputTokens: count, textOutputTokens: count, toolInputTokens: count }),
  usageIsFinal: v.boolean(),
  timing: v.optional(v.strictObject({ queueMs: count, firstTokenMs: count, durationMs: count })),
  context: v.optional(contextEstimateSchema),
});
