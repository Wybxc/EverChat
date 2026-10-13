import { openProviderStream, GenerationCancelled, ProviderError } from '../../worker/provider';
import { ProviderStream, StreamParseError } from '../../shared/provider-stream';
import type { ProviderConfig, ChatInput } from '../../shared/types';

// Unit-test consumer exercises request construction and the shared decoder together.
export async function generate(config: ProviderConfig, context: ChatInput[], onDelta: (delta: string) => Promise<void>, signal: AbortSignal, onReasoning: (delta: string) => Promise<void> = async () => {}) {
  const body = await openProviderStream(config, context, signal), reader = body.getReader();
  const parser = new ProviderStream(config.provider, true);
  try {
    while (true) {
      if (signal.aborted) throw new ProviderError('模型供应商连接已中断。');
      const next = await reader.read();
      if (next.done) break;
      parser.feed(next.value);
      for (const delta of parser.drainDeltas()) await (delta.kind === 'content' ? onDelta(delta.text) : onReasoning(delta.text));
      const failure = parser.checkpoint().failure;
      if (failure) throw new ProviderError(failure);
    }
    parser.assertComplete();
    for (const delta of parser.drainDeltas()) await (delta.kind === 'content' ? onDelta(delta.text) : onReasoning(delta.text));
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (error instanceof StreamParseError) throw new ProviderError(error.message);
    throw new ProviderError('模型供应商连接已中断。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
