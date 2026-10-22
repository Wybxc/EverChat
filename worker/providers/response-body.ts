export class ProviderResponseTooLarge extends Error {}

/** Small non-streaming auxiliary calls must not buffer an unbounded body. */
export async function boundedJsonResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Response> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) throw new ProviderResponseTooLarge();
      chunks.push(result.value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(bytes, { status: response.status, headers: response.headers });
}
