import * as v from 'valibot';
import { contextEstimateSchema, type ContextEstimate } from '../conversation/context-budget';
import { errorIssueSchema, type ErrorIssue } from '../errors/descriptor';
import { providerFailureSchema, type ProviderFailure } from '../providers/failure';
import type { StreamState, StreamUsage } from './provider-stream';

export interface GenerationTiming {
  queueMs?: number;
  firstTokenMs?: number;
  durationMs?: number;
}
export interface GenerationResult {
  finishReason?: StreamState['finishReason'];
  rawFinishReason?: string;
  finishMessage?: string;
  /** A retained ordinary answer whose supplier stream ended before successful completion. */
  interrupted?: true;
  usage: StreamUsage;
  usageIsFinal: boolean;
  timing?: GenerationTiming;
  context?: ContextEstimate;
  failure?: ProviderFailure;
  issue?: ErrorIssue;
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
  finishReason: v.optional(
    v.picklist(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']),
  ),
  rawFinishReason: v.optional(v.pipe(v.string(), v.maxLength(128))),
  finishMessage: v.optional(v.pipe(v.string(), v.maxLength(4096))),
  interrupted: v.optional(v.literal(true)),
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
  failure: v.optional(providerFailureSchema),
  issue: v.optional(errorIssueSchema),
});
