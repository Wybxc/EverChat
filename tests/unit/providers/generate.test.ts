import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig } from '../../../shared/providers/types';
import {
  AUXILIARY_RESPONSE_BYTES,
  generateProviderText,
  type ProviderTextResult,
} from '../../../worker/providers/generate';

const config: ProviderConfig = {
  provider: 'openai-chat',
  baseUrl: 'https://provider.example/v1',
  model: 'internal-text',
  apiKey: 'fixture-private-key',
  systemPrompt: 'Only a title',
  maxOutputTokens: 128,
};
const input = [{ role: 'user' as const, content: 'private question and answer' }];
const body = (reason = 'stop', text = 'A title') => ({
  id: 'fixture',
  model: config.model,
  created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reason }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

test('internal text uses one non-streaming Core request and reports valid usage even when output is truncated', async (t) => {
  let requests = 0,
    starts = 0;
  const observed: ProviderTextResult[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++;
    assert.equal(starts, requests, 'request accounting precedes the actual call');
    const request = new Request(url, init),
      data = (await request.json()) as Record<string, unknown>;
    assert.equal(init.redirect, 'manual');
    assert.equal(data.stream, undefined);
    assert.equal(data.max_tokens, 128);
    assert.deepEqual(data.messages, [{ role: 'system', content: config.systemPrompt }, ...input]);
    assert.equal(data.tools, undefined);
    return Response.json(body('length'));
  });
  const result = await generateProviderText(
    config,
    input,
    new AbortController().signal,
    async () => {
      starts++;
    },
    (value) => observed.push(value),
  );
  assert.equal(requests, 1);
  assert.equal(result.finishReason, 'length');
  assert.equal(result.usageIsFinal, true);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 4);
  assert.deepEqual(observed, [result]);
});

test('internal text never retries HTTP errors, limits response buffering, and preserves caller cancellation', async (t) => {
  let requests = 0,
    cancelled = false;
  let fetchResponse: () => Response = () => new Response('fixture-private-key', { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return fetchResponse();
  });
  await assert.rejects(
    generateProviderText(config, input, new AbortController().signal),
    (error: Error) => {
      assert.doesNotMatch(JSON.stringify(error), /fixture-private-key|private question/);
      return true;
    },
  );
  assert.equal(requests, 1);
  fetchResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(AUXILIARY_RESPONSE_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(generateProviderText(config, input, new AbortController().signal));
  assert.equal(requests, 2);
  assert.equal(cancelled, true);
  const abort = new AbortController();
  abort.abort(new Error('caller stopped'));
  await assert.rejects(generateProviderText(config, input, abort.signal), /caller stopped/);
  assert.equal(requests, 2);
});
