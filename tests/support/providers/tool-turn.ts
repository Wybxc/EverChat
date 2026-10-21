import type { ProviderConfig } from '../../../shared/providers/types';
import type { WebToolName } from '../../../shared/web-tools/tasks';
import { providerModel } from '../../../worker/providers/sdk';
import { coreProviderStream } from '../../../worker/providers/core';
import { providerEvents } from '../../../worker/providers/events';
import { ProviderWireGuard } from '../../../worker/providers/stream-errors';
import { sdkProviderError } from '../../../worker/providers/sdk-diagnostics';

// Synthetic native supplier body, parsed exactly once. No real network or replay
// in production; lifecycle fixtures use this to construct private turn records.
export async function fixtureStream(
  config: ProviderConfig,
  enabled: readonly WebToolName[],
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  const guard = new ProviderWireGuard();
  const fetch: typeof globalThis.fetch = async () =>
    new Response(guard.wrap(body, signal), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await coreProviderStream(
      providerModel(config, fetch),
      config,
      [{ role: 'user', content: 'Fixture' }],
      signal,
      { enabled },
    );
    return providerEvents(result.stream, config, guard, signal, [], () => undefined, result.native);
  } catch (error) {
    await guard.cancel();
    throw sdkProviderError(error, config, 'protocol');
  }
}
export async function collectProviderToolTurn(
  config: ProviderConfig,
  enabled: readonly WebToolName[],
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  const output = await fixtureStream(config, enabled, body, signal);
  await new Response(output).arrayBuffer();
  if (!output.toolTurn) throw new Error('Fixture did not complete a tool turn');
  return output.toolTurn;
}
