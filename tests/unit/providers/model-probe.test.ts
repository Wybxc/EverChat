import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageDimensions } from '../../../shared/attachments/images';
import type { ProbeCapability } from '../../../shared/models/probe';
import type { ProviderConfig, ProviderKind } from '../../../shared/providers/types';
import {
  PROBE_RESPONSE_BYTES,
  PROBE_TIMEOUT_MS,
  probeModelCapability,
} from '../../../worker/providers/probe';
import { probeImage } from '../../../worker/providers/probe-image';

const nonce = 'A1B2C3',
  uuid = 'a1b2c3d4-0000-4000-8000-000000000001';
const config: ProviderConfig = {
  provider: 'openai-chat',
  model: 'probe-model',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'private-test-key',
  systemPrompt: 'private conversation prompt',
  maxOutputTokens: null,
  reasoningEnabled: true,
  reasoningEffort: 'high',
};
const signal = () => new AbortController().signal;
function response(
  provider: ProviderKind,
  capability: ProbeCapability,
  value: string = nonce,
  tool = 'everchat_capability_probe',
) {
  const input = { challenge: value };
  if (provider === 'openai-chat')
    return {
      id: 'probe',
      model: 'probe-model',
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: capability === 'toolCalls' ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: capability === 'toolCalls' ? null : value,
            ...(capability === 'toolCalls'
              ? {
                  tool_calls: [
                    {
                      id: 'call',
                      type: 'function',
                      function: { name: tool, arguments: JSON.stringify(input) },
                    },
                  ],
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
  if (provider === 'openai-responses')
    return {
      id: 'probe',
      created_at: 1,
      model: 'probe-model',
      output:
        capability === 'toolCalls'
          ? [
              {
                type: 'function_call',
                id: 'item',
                call_id: 'call',
                name: tool,
                arguments: JSON.stringify(input),
              },
            ]
          : [
              {
                type: 'message',
                id: 'item',
                role: 'assistant',
                content: [{ type: 'output_text', text: value, annotations: [] }],
              },
            ],
    };
  if (provider === 'anthropic')
    return {
      id: 'probe',
      type: 'message',
      role: 'assistant',
      model: 'probe-model',
      stop_reason: capability === 'toolCalls' ? 'tool_use' : 'end_turn',
      content:
        capability === 'toolCalls'
          ? [{ type: 'tool_use', id: 'call', name: tool, input }]
          : [{ type: 'text', text: value }],
      usage: { input_tokens: 10, output_tokens: 4 },
    };
  return {
    responseId: 'probe',
    candidates: [
      {
        content: {
          role: 'model',
          parts:
            capability === 'toolCalls'
              ? [{ functionCall: { name: tool, args: input } }]
              : [{ text: value }],
        },
        finishReason: 'STOP',
      },
    ],
  };
}
for (const [provider, official] of [
  ['openai-chat', false],
  ['openai-chat', true],
  ['openai-responses', false],
  ['anthropic', false],
  ['gemini', false],
] as const) {
  test(`${provider}${official ? ' official' : ''} probes real text, image bytes and parsed tool calls with isolated bounded requests`, async (t) => {
    t.mock.method(crypto, 'randomUUID', () => uuid);
    const captured: string[] = [];
    for (const capability of ['text', 'imageInput', 'toolCalls'] as const) {
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init),
          body = (await request.json()) as Record<string, any>,
          serialized = JSON.stringify(body);
        captured.push(capability);
        assert.equal(init?.redirect, 'manual');
        assert.ok(init?.signal);
        assert.ok(!serialized.includes(config.systemPrompt));
        assert.ok(!serialized.includes('private-test-key'));
        assert.ok(!serialized.includes('reasoning_effort'));
        assert.ok(!serialized.includes('adaptive'));
        assert.ok(!serialized.includes('web_search'));
        assert.ok(!serialized.includes('read_webpage'));
        if (provider === 'gemini') {
          assert.equal(request.headers.get('x-goog-api-key'), config.apiKey);
          assert.equal(body.generationConfig.maxOutputTokens, 256);
        } else if (provider === 'anthropic') {
          assert.equal(request.headers.get('x-api-key'), config.apiKey);
          assert.equal(body.max_tokens, 256);
        } else {
          assert.equal(request.headers.get('authorization'), `Bearer ${config.apiKey}`);
          assert.equal(
            body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
            256,
          );
        }
        if (capability === 'imageInput') {
          const encoded = Buffer.from(probeImage(nonce)).toString('base64');
          assert.ok(serialized.includes(encoded));
          assert.ok(!serialized.includes(nonce), 'image answer must not appear in prompt text');
        }
        if (capability === 'toolCalls') {
          assert.ok(serialized.includes('everchat_capability_probe'));
          assert.ok(serialized.includes(nonce));
        }
        return Response.json(response(provider, capability));
      };
      const result = await probeModelCapability(
        { ...config, provider, ...(official ? { baseUrl: 'https://api.openai.com/v1' } : {}) },
        capability,
        signal(),
        fetch,
      );
      assert.equal(result.status, 'confirmed', `${capability}: ${JSON.stringify(result)}`);
      assert.equal(result.reason, 'matched');
      assert.ok(result.testedAt > 0);
    }
    assert.deepEqual(captured, ['text', 'imageInput', 'toolCalls']);
  });
}
test('HTTP success, text pretending to be a tool, wrong challenge and wrong tool never establish support', async (t) => {
  t.mock.method(crypto, 'randomUUID', () => uuid);
  for (const [capability, raw] of [
    ['text', response('openai-chat', 'text', 'Hello')],
    ['imageInput', response('openai-chat', 'imageInput', 'FFFFFF')],
    ['toolCalls', response('openai-chat', 'text', '{"challenge":"A1B2C3"}')],
    ['toolCalls', response('openai-chat', 'toolCalls', 'FFFFFF')],
    ['toolCalls', response('openai-chat', 'toolCalls', nonce, 'arbitrary_execution')],
  ] as [ProbeCapability, unknown][]) {
    const result = await probeModelCapability(config, capability, signal(), async () =>
      Response.json(raw),
    );
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.reason, 'mismatch');
  }
});
test('a required-tool mismatch retains the completed request usage without retrying or executing tools', async (t) => {
  t.mock.method(crypto, 'randomUUID', () => uuid);
  let requests = 0,
    starts = 0;
  const finished: unknown[] = [];
  const result = await probeModelCapability(
    config,
    'toolCalls',
    signal(),
    async () => {
      requests++;
      return Response.json(response('openai-chat', 'text', 'I cannot call tools'));
    },
    {
      async start() {
        starts++;
      },
      finish(...args) {
        finished.push(args);
      },
    },
  );
  assert.equal(result.reason, 'mismatch');
  assert.equal(requests, 1);
  assert.equal(starts, 1);
  assert.deepEqual(finished, [
    [
      'completed',
      {
        inputTokens: 10,
        uncachedInputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 4,
        textOutputTokens: 4,
        reasoningTokens: 0,
      },
      true,
      200,
    ],
  ]);
});
test('failed and redirected probes make one request, redact credentials in diagnostics and leave capability unconfirmed', async () => {
  for (const status of [302, 401, 429, 500]) {
    let calls = 0;
    const result = await probeModelCapability(config, 'text', signal(), async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response('private-test-key private diagnostic', {
        status,
        headers: { Location: 'https://other.test' },
      });
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.reason, 'request-failed');
    assert.ok(!JSON.stringify(result).includes('private-test-key'));
    assert.equal(result.failure?.status, status);
    assert.match(result.failure?.message ?? '', /\[已隐藏\].*private diagnostic/);
  }
});
test('oversized response streams are cancelled before JSON parsing; timeout and caller cancellation stop requests', async (t) => {
  let cancelled = false;
  const result = await probeModelCapability(
    config,
    'text',
    signal(),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(PROBE_RESPONSE_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  assert.equal(result.reason, 'response-too-large');
  assert.equal(cancelled, true);
  const abort = new AbortController();
  abort.abort(new Error('caller cancelled'));
  await assert.rejects(
    probeModelCapability(config, 'text', abort.signal, async () => {
      throw new Error('Must not fetch');
    }),
    /caller cancelled/,
  );
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, PROBE_TIMEOUT_MS);
    return AbortSignal.abort(new Error('timeout'));
  });
  assert.equal(
    (
      await probeModelCapability(config, 'text', signal(), async () => {
        throw new Error('Must not fetch');
      })
    ).reason,
    'timeout',
  );
});
test('the challenge image is a bounded real PNG containing only pixels, with distinct codes producing distinct images', () => {
  const png = probeImage(nonce);
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 199, height: 59 });
  assert.ok(png.length < 1024);
  assert.ok(!Buffer.from(png).includes(Buffer.from(nonce)));
  assert.notDeepEqual(png, probeImage('D4E5F6'));
  assert.throws(() => probeImage('invalid'));
});
