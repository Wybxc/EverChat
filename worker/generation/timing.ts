import type { GenerationTiming } from '../../shared/streaming/generation';

export function generationTiming(
  acceptedAt: number,
  claimedAt: number | null,
  provider?: { providerStartedAt: number; firstTokenAt: number | null },
  endedAt?: number,
): GenerationTiming {
  const duration = (end: number, start: number) => Math.max(0, end - start);
  return {
    ...(claimedAt !== null ? { queueMs: duration(claimedAt, acceptedAt) } : {}),
    ...(provider?.firstTokenAt !== undefined && provider.firstTokenAt !== null
      ? { firstTokenMs: duration(provider.firstTokenAt, provider.providerStartedAt) }
      : {}),
    ...(provider && endedAt !== undefined
      ? { durationMs: duration(endedAt, provider.providerStartedAt) }
      : {}),
  };
}
