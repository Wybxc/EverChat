import type { StreamUsage } from '../streaming/provider-stream';
import type { LanguageModelUsage } from 'ai';

export function coreUsage(usage: LanguageModelUsage): StreamUsage {
  return sdkUsage({
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokenDetails.noCacheTokens,
      cacheRead: usage.inputTokenDetails.cacheReadTokens,
      cacheWrite: usage.inputTokenDetails.cacheWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokenDetails.textTokens,
      reasoning: usage.outputTokenDetails.reasoningTokens,
    },
  });
}

/** AI SDK v4 counters use inclusive totals. Never add the reasoning/cache subsets again. */
export function sdkUsage(usage: {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
}): StreamUsage {
  return Object.fromEntries(
    Object.entries({
      inputTokens: usage.inputTokens.total,
      uncachedInputTokens: usage.inputTokens.noCache,
      cachedInputTokens: usage.inputTokens.cacheRead,
      cacheWriteInputTokens: usage.inputTokens.cacheWrite,
      outputTokens: usage.outputTokens.total,
      textOutputTokens: usage.outputTokens.text,
      reasoningTokens: usage.outputTokens.reasoning,
    }).filter(([, value]) => value !== undefined),
  );
}
