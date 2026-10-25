import * as v from 'valibot';
import { generationDiagnosticsSchema, type GenerationDiagnostics } from './diagnostics';
import { contextEstimateSchema, type ContextEstimate } from '../conversation/context-budget';
import { errorIssueSchema, type ErrorIssue } from '../errors/descriptor';
import { providerFailureSchema, type ProviderFailure } from '../providers/failure';
import type { StreamState, StreamUsage } from './provider-stream';
import {
  USAGE_FIELDS,
  usageSourcesSchema,
  usageCoverageSchema,
  type UsageSources,
  type UsageCoverage,
  type UsageSource,
} from '../usage/evidence';

export interface GenerationTiming {
  queueMs?: number;
  firstTokenMs?: number;
  durationMs?: number;
}
export interface GenerationResult {
  finishReason?: StreamState['finishReason'];
  rawFinishReason?: string;
  finishMessage?: string;
  diagnostics?: GenerationDiagnostics;
  /** A retained ordinary answer whose supplier stream ended before successful completion. */
  interrupted?: true;
  usage: StreamUsage;
  usageIsFinal: boolean;
  usageSources?: UsageSources;
  usageCoverage?: UsageCoverage;
  timing?: GenerationTiming;
  context?: ContextEstimate;
  failure?: ProviderFailure;
  issue?: ErrorIssue;
}
export type GenerationUsage = Pick<
  GenerationResult,
  'usage' | 'usageIsFinal' | 'usageSources' | 'usageCoverage'
>;
export function addGenerationUsage(
  previous: GenerationUsage | undefined,
  current: GenerationUsage,
): GenerationUsage {
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
  if (current.usageSources === undefined && previous?.usageCoverage === undefined)
    return { usage, usageIsFinal };
  const fields: UsageCoverage['fields'] = {};
  const sources: UsageSources = {};
  for (const field of USAGE_FIELDS) {
    const before = previous?.usageCoverage?.fields[field];
    const reported = (before?.reported ?? 0) + (current.usage[field] === undefined ? 0 : 1);
    if (!reported) continue;
    const a = before?.source,
      b =
        current.usage[field] === undefined
          ? undefined
          : (current.usageSources?.[field] ?? 'unknown');
    const source: UsageSource =
      a === 'unknown' || b === 'unknown'
        ? 'unknown'
        : a === 'derived' || b === 'derived'
          ? 'derived'
          : 'provider_reported';
    fields[field] = { reported, source };
    sources[field] = source;
  }
  return {
    usage,
    usageIsFinal,
    usageSources: sources,
    usageCoverage: { steps: (previous?.usageCoverage?.steps ?? 0) + 1, fields },
  };
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
  diagnostics: v.optional(generationDiagnosticsSchema),
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
  usageSources: v.optional(usageSourcesSchema),
  usageCoverage: v.optional(usageCoverageSchema),
  timing: v.optional(v.strictObject({ queueMs: count, firstTokenMs: count, durationMs: count })),
  context: v.optional(contextEstimateSchema),
  failure: v.optional(providerFailureSchema),
  issue: v.optional(errorIssueSchema),
});
