import type { GenerationBuffer } from './buffer';
import { GenerationCancelled, ProviderError } from './errors';

export type ActiveGeneration = {
  runId: string;
  abort: AbortController;
  buffer: GenerationBuffer;
  cancelled: boolean;
  endedAt?: number;
  failure?: Error;
  timer?: ReturnType<typeof setInterval>;
};

// Backpressure and cancellation checks remain between reads; buffer owns commit cadence.
export async function consumeModelStream(
  body: ReadableStream<Uint8Array>,
  active: ActiveGeneration,
  onChunk: (bytes: Uint8Array) => void | Promise<void>,
) {
  const reader = body.getReader();
  try {
    while (true) {
      if (active.cancelled) throw new GenerationCancelled();
      if (active.failure) throw active.failure;
      if (active.abort.signal.aborted) throw new ProviderError('模型供应商连接已中断。');
      const next = await reader.read();
      const receivedAt = Date.now();
      if (next.done) {
        active.endedAt ??= receivedAt;
        break;
      }
      if (active.cancelled) throw new GenerationCancelled();
      await onChunk(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
