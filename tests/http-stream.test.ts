import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonWithStream } from '../worker/http';

test('large native histories are composed as valid JSON without changing bytes or response privacy', async () => {
  const snapshot = { messages: ['资料🙂'.repeat(700000)] }, response = jsonWithStream({ id: 'copy' }, 'snapshot', Response.json(snapshot), 201);
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { id: 'copy', snapshot });
});
test('cancelling a composed response cancels its native upstream, and error responses keep their status', async () => {
  let cancelled: unknown;
  const stream = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled = reason; } });
  const response = jsonWithStream({}, 'snapshot', new Response(stream));
  await response.body!.cancel('disconnected'); assert.equal(cancelled, 'disconnected');
  const failure = Response.json({ error: 'deleted' }, { status: 410 });
  assert.equal(jsonWithStream({}, 'snapshot', failure), failure);
});
