import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ProviderKind, ProviderConfig } from '../../../shared/providers/types';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { openProviderStream, ProviderError } from '../../../worker/providers/stream';
import { providerStreams } from '../../support/providers/streams';
import { ResponseReasoning } from '../../../worker/providers/response-reasoning';
const config = (provider: ProviderKind): ProviderConfig => ({
  provider,
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture',
  apiKey: 'private-fixture-key',
  systemPrompt: 'private system prompt',
  maxOutputTokens: null,
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function consume(
  t: TestContext,
  provider: ProviderKind,
  wire: string | Uint8Array,
  overrides: Partial<ProviderConfig> = {},
) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(typeof wire === 'string' ? wire : new Uint8Array(wire), {
      headers: { 'content-type': 'text/event-stream', 'request-id': 'fixture-request' },
    });
  });
  const outputTimes: number[] = [];
  const parser = new ProviderStream(provider, true),
    body = await openProviderStream(
      { ...config(provider), ...overrides },
      [],
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      (time) => outputTimes.push(time),
    );
  let failure: unknown;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parser.feed(next.value);
    }
  } catch (error) {
    failure = error;
  }
  assert.equal(calls, 1);
  return { parser, failure, outputTimes };
}
for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${provider} SDK decoding streams separate channels and final usage, while missing native completion retains a non-final prefix`, async (t) => {
    const fixture = providerStreams[provider];
    const full = await consume(t, provider, fixture.partial + fixture.finish);
    assert.equal(full.failure, undefined);
    assert.equal(full.outputTimes.length, 1);
    assert.ok(full.outputTimes[0] <= Date.now());
    full.parser.assertComplete();
    assert.equal(full.parser.reasoning, '**思考🙂**\n结论。');
    assert.equal(full.parser.content, '**正文🙂**\n答案。');
    assert.equal(full.parser.checkpoint().usageIsFinal, true);
    t.mock.restoreAll();
    const partial = await consume(t, provider, fixture.partial);
    assert.ok(partial.failure instanceof ProviderError);
    assert.equal(partial.outputTimes.length, 1);
    assert.equal(partial.parser.content, '**正文🙂**\n');
    assert.equal(partial.parser.checkpoint().usageIsFinal, false);
  });
}
test('a Chat finish reason without DONE is interrupted, and invalid UTF-8 preserves only valid earlier events', async (t) => {
  const fixture = providerStreams['openai-chat'];
  const interrupted = await consume(
    t,
    'openai-chat',
    (fixture.partial + fixture.finish).replace('data: [DONE]\r\n\r\n', ''),
  );
  assert.ok(interrupted.failure instanceof ProviderError);
  assert.equal(interrupted.parser.checkpoint().done, false);
  t.mock.restoreAll();
  const bytes = Buffer.concat([Buffer.from(fixture.partial), Buffer.from([0xff])]);
  const invalid = await consume(t, 'openai-chat', bytes);
  assert.ok(invalid.failure instanceof ProviderError);
  assert.equal(invalid.parser.checkpoint().done, false);
});
test('a filtered Gemini finish preserves raw reason and safe provider message', async (t) => {
  const value = await consume(
    t,
    'gemini',
    frame({
      candidates: [
        {
          index: 0,
          content: { parts: [{ text: 'partial' }] },
          finishReason: 'SAFETY',
          finishMessage: 'Filtered private-fixture-key',
        },
      ],
    }),
  );
  assert.ok(value.failure instanceof ProviderError);
  assert.equal(value.parser.content, 'partial');
  assert.equal(value.parser.checkpoint().finishReason, 'content-filter');
  assert.equal(value.parser.checkpoint().rawFinishReason, 'SAFETY');
  assert.equal(value.parser.checkpoint().finishMessage, 'Filtered [已隐藏]');
  assert.throws(() => value.parser.assertComplete());
});
test('an in-stream error latches before a subsequent successful finish and retains a sanitized response body', async (t) => {
  const fixture = providerStreams['openai-chat'];
  const value = await consume(
    t,
    'openai-chat',
    fixture.partial +
      frame({
        error: {
          code: 'upstream_disconnect',
          message: 'Lost private-fixture-key',
          request: { messages: ['private content'] },
          detail: 'safe reason',
        },
      }) +
      fixture.finish,
  );
  assert.ok(value.failure instanceof ProviderError);
  assert.equal(value.parser.content, '**正文🙂**\n');
  assert.equal(value.parser.checkpoint().done, false);
  assert.match(value.failure.details?.responseBody ?? '', /safe reason/);
  assert.doesNotMatch(
    value.failure.details?.responseBody ?? '',
    /private content|private-fixture-key/,
  );
});
test('an initial usage report is not final merely because a later SDK finish succeeds', async (t) => {
  const value = await consume(
    t,
    'openai-chat',
    frame({
      choices: [{ delta: { role: 'assistant' } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }) +
      frame({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n',
  );
  assert.equal(value.failure, undefined);
  value.parser.assertComplete();
  assert.equal(value.parser.checkpoint().usageIsFinal, false);
  assert.equal(value.parser.checkpoint().usage.inputTokens, 10);
});
test('Responses chooses raw thoughts in either arrival order and bounds raw identifiers', () => {
  for (const first of ['reasoning_summary_text', 'reasoning_text']) {
    const thoughts = new ResponseReasoning(),
      parser = new ProviderStream('openai-responses', true);
    for (const channel of [
      first,
      first === 'reasoning_text' ? 'reasoning_summary_text' : 'reasoning_text',
    ]) {
      const event = thoughts.observe({
        type: `response.${channel}.delta`,
        item_id: 'rs',
        content_index: 0,
        summary_index: 0,
        delta: channel === 'reasoning_text' ? 'full🙂' : 'summary',
      });
      if (event) parser.feed(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    }
    assert.equal(parser.reasoning, 'full🙂');
    assert.equal(
      thoughts.observe({ type: 'response.reasoning_text.done', item_id: 'rs', text: 'full🙂' }),
      undefined,
    );
    assert.throws(() =>
      thoughts.observe({
        type: 'response.reasoning_text.delta',
        item_id: 'x'.repeat(201),
        delta: 'overflow',
      }),
    );
  }
});

test('metadata and empty content do not count as first output, and absent usage stays unknown', async (t) => {
  const empty = await consume(
    t,
    'openai-chat',
    frame({
      id: 'empty',
      model: 'actual',
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    }) + 'data: [DONE]\n\n',
  );
  assert.deepEqual(empty.outputTimes, []);
  assert.equal(empty.parser.checkpoint().diagnostics?.response?.model, 'actual');
  assert.deepEqual(empty.parser.checkpoint().usage, {});
});

test('real SDK unsupported-setting warnings survive a disconnected response and carry only allowed headers', async (t) => {
  const fixture = providerStreams['openai-chat'];
  const result = await consume(t, 'openai-chat', fixture.partial, {
    baseUrl: 'https://api.openai.com/v1',
    model: 'o3',
    temperature: 0.4,
  });
  assert.ok(result.failure instanceof ProviderError);
  assert.ok(result.parser.content);
  const diagnostics = result.parser.checkpoint().diagnostics!;
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('temperature')));
  assert.equal(diagnostics.response?.requestId, 'fixture-request');
  assert.equal(diagnostics.response?.model, 'fixture-actual-model');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-fixture-key|private system prompt/);
});
