import * as v from 'valibot';
import type { StreamUsage } from '../streaming/provider-stream';

export const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
  'uncachedInputTokens',
  'textOutputTokens',
  'toolInputTokens',
] as const;
export const usageSourceSchema = v.picklist(['provider_reported', 'derived', 'unknown']);
export type UsageSource = v.InferOutput<typeof usageSourceSchema>;
export type UsageSources = Partial<Record<keyof StreamUsage, UsageSource>>;
export const usageSourcesSchema = v.partial(
  v.strictObject(
    Object.fromEntries(USAGE_FIELDS.map((field) => [field, usageSourceSchema])) as Record<
      keyof StreamUsage,
      typeof usageSourceSchema
    >,
  ),
);
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const coverageFieldSchema = v.strictObject({ reported: count, source: usageSourceSchema });
export const usageCoverageSchema = v.strictObject({
  steps: count,
  fields: v.partial(
    v.strictObject(
      Object.fromEntries(USAGE_FIELDS.map((field) => [field, coverageFieldSchema])) as Record<
        keyof StreamUsage,
        typeof coverageFieldSchema
      >,
    ),
  ),
});
export type UsageCoverage = v.InferOutput<typeof usageCoverageSchema>;

function derivation(field: keyof StreamUsage, protocol?: string) {
  if (field === 'inputTokens' && protocol === 'anthropic')
    return 'uncached_input + cache_read_input(default 0) + cache_creation_input(default 0)';
  if (field === 'inputTokens' && protocol === 'gemini')
    return 'promptTokenCount + toolUsePromptTokenCount(default 0)';
  if (field === 'outputTokens' && protocol === 'gemini')
    return 'candidatesTokenCount + thoughtsTokenCount(default 0)';
  if (field === 'uncachedInputTokens')
    return 'inputTokens - cachedInputTokens - cacheWriteInputTokens(default 0)';
  if (field === 'textOutputTokens') return 'outputTokens - reasoningTokens';
  return null;
}

export function mcpUsage(
  usage: StreamUsage,
  sources: UsageSources | undefined,
  coverage: UsageCoverage | undefined,
  expectedSteps: number,
  isFinal: boolean,
  finalized: boolean,
  protocol?: string,
) {
  const dimensions = Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      const knownSubtotal = usage[field] ?? null;
      const reportedSteps = coverage?.fields[field]?.reported ?? null;
      const complete =
        coverage?.steps === expectedSteps && reportedSteps === expectedSteps && expectedSteps > 0;
      return [
        field,
        {
          value: complete ? knownSubtotal : null,
          source: coverage?.fields[field]?.source ?? sources?.[field] ?? 'unknown',
          knownSubtotal,
          reportedSteps,
          expectedSteps,
          derivation:
            (coverage?.fields[field]?.source ?? sources?.[field]) === 'derived'
              ? derivation(field, protocol)
              : null,
        },
      ];
    }),
  ) as Record<
    keyof StreamUsage,
    {
      value: number | null;
      source: UsageSource;
      knownSubtotal: number | null;
      reportedSteps: number | null;
      expectedSteps: number;
      derivation: string | null;
    }
  >;
  const counts = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, dimensions[field].value]),
  ) as Record<keyof StreamUsage, number | null>;
  const anyKnown = Object.values(counts).some((value) => value !== null);
  const complete = ['inputTokens', 'outputTokens', 'totalTokens'].every(
    (field) => counts[field as keyof StreamUsage] !== null,
  );
  const inconsistent =
    counts.inputTokens !== null &&
    counts.outputTokens !== null &&
    counts.totalTokens !== null &&
    counts.inputTokens + counts.outputTokens !== counts.totalTokens;
  return {
    ...counts,
    dimensions,
    isFinal,
    finalized,
    completeness: complete
      ? ('complete' as const)
      : anyKnown
        ? ('partial' as const)
        : ('unknown' as const),
    warnings: inconsistent ? (['inconsistent_usage'] as const).slice() : [],
  };
}
