import type { ProviderConfig } from '../../../shared/providers/types';
import type { WebToolName } from '../../../shared/web-tools/tasks';
import { providerCallOptions, providerModel } from '../../../worker/providers/sdk';
import { providerEvents } from '../../../worker/providers/events';
import { ProviderWireGuard } from '../../../worker/providers/stream-errors';
import { webToolDefinitions } from '../../../worker/providers/tool-turn';

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
  const result = await providerModel(config, fetch).doStream(
    providerCallOptions(config, [], signal, webToolDefinitions(enabled)),
  );
  return providerEvents(result.stream, config, guard, signal, [], undefined, { enabled });
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
