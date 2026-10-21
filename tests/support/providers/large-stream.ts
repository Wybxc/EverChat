/** Raw SSE includes heartbeats that the SDK omits from the application event stream. */
export function* largeProviderStream(): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeat = encoder.encode(`: ${'keepalive '.repeat(3277)}\n\n`);
  for (let index = 0; index < 160; index++) yield heartbeat;
  yield encoder.encode(
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思'.repeat(110_000), content: '答'.repeat(110_000) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
}
