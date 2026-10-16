import type { GenerationBuffer } from './buffer';
import { GenerationCancelled,ProviderError } from './errors';
import type { FirstTokenProbe } from './timing';

export type ActiveGeneration = { runId: string; abort: AbortController; buffer: GenerationBuffer; privateBuffer?: GenerationBuffer; cancelled: boolean; endedAt?: number; failure?: Error; persistence?: Promise<void>; timer?: ReturnType<typeof setInterval> };

// Backpressure and cancellation checks remain between reads; buffer owns commit cadence.
export async function consumeModelStream(body: ReadableStream<Uint8Array>, active: ActiveGeneration, probe: FirstTokenProbe, onChunk: (bytes: Uint8Array) => void) {
  const reader = body.getReader();
      try {
        while (true) {
          if (active.cancelled) throw new GenerationCancelled();
          if (active.failure) throw active.failure;
          if (active.abort.signal.aborted) throw new ProviderError('模型供应商连接已中断。');
          await active.persistence;
          const next = await reader.read();
          const receivedAt = Date.now();
          if (next.done) { active.endedAt ??= receivedAt; probe.end(receivedAt); break; }
          if (active.cancelled) throw new GenerationCancelled();
          probe.feed(next.value, receivedAt);
          onChunk(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }

}
