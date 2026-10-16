import { ProviderStream } from '../../shared/streaming/provider-stream';
import type { GenerationTiming } from '../../shared/streaming/generation';
import type { ProviderKind } from '../../shared/providers/types';

// Inspect only the prefix needed to observe a first output. Later bytes stay on the raw forwarding path.
export class FirstTokenProbe {
  private parser: ProviderStream | undefined;
  constructor(
    protocol: ProviderKind,
    private readonly observed: (receivedAt: number) => void,
  ) {
    this.parser = new ProviderStream(protocol, true);
  }
  feed(bytes: Uint8Array, receivedAt: number) {
    for (let offset = 0; this.parser && offset < bytes.length; offset += 4096) {
      this.parser.feed(bytes.subarray(offset, offset + 4096));
      this.check(receivedAt);
    }
  }
  end(receivedAt: number) {
    this.parser?.end();
    this.check(receivedAt);
  }
  private check(receivedAt: number) {
    if (!this.parser) return;
    if (this.parser.content || this.parser.reasoning) {
      this.parser = undefined;
      this.observed(receivedAt);
    } else if (this.parser.failed) this.parser = undefined;
  }
}

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
