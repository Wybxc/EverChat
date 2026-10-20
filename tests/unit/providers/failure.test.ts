import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { providerFailureSchema } from '../../../shared/providers/failure';
import { generationSchema } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import type { ProviderConfig } from '../../../shared/providers/types';
import { ProviderError } from '../../../worker/generation/errors';
import { httpProviderError, providerFailure } from '../../../worker/providers/failure';
import { openProviderStream } from '../../../worker/providers/stream';
import { safeProviderStream } from '../../../worker/providers/stream-errors';
import { providerStreams } from '../../support/providers/streams';
import { failureDiagnosticText } from '../../../src/features/providers/failure-details';

const config: ProviderConfig = {
  provider: 'openai-chat',
  baseUrl: 'https://provider.test/v1',
  model: 'test-model',
  modelName: 'Test',
  providerName: 'Provider',
  apiKey: 'private-test-key',
  systemPrompt: 'private-system-instructions',
  maxOutputTokens: null,
};

test('HTTP diagnostics allowlist supplier fields, strip credentials and request echoes, and distinguish rate limits from quota', async () => {
  const error = await httpProviderError(
    Response.json(
      {
        error: {
          code: 'rate_limit_exceeded',
          type: 'rate_limit_error',
          message:
            'Too many requests. private-test-key private-system-instructions Bearer another-token https://name:pass@example.test/v1?token=secret#key',
          request: { authorization: 'private-test-key', messages: ['private prompt'] },
        },
        headers: { authorization: 'private-test-key' },
      },
      {
        status: 429,
        headers: { 'x-request-id': 'req-123', 'Retry-After': '30', 'Set-Cookie': 'private-cookie' },
      },
    ),
    {
      ...config,
      baseUrl: 'https://name:pass@provider.test/v1?api_key=private-test-key#secret',
    },
  );
  assert.match(error.message, /限制了请求/);
  assert.equal(error.details?.code, 'rate_limit_exceeded');
  assert.equal(error.details?.type, 'rate_limit_error');
  assert.equal(error.details?.requestId, 'req-123');
  assert.equal(error.details?.retryAfter, '30');
  assert.equal(error.details?.endpoint, 'https://provider.test/v1');
  assert.match(error.details?.message ?? '', /Too many requests/);
  assert.match(error.details?.responseBody ?? '', /rate_limit_exceeded/);
  assert.match(error.details?.responseBody ?? '', /\[已省略请求内容\]/);
  assert.ok(
    failureDiagnosticText(error.message, error.details!).includes(error.details!.responseBody!),
  );
  const serialized = JSON.stringify(error.details);
  for (const secret of [
    'private-test-key',
    'private-system-instructions',
    'another-token',
    'pass@',
    'token=secret',
    'private-cookie',
    'private prompt',
  ])
    assert.ok(!serialized.includes(secret), secret);
  assert.ok(v.safeParse(providerFailureSchema, error.details).success);
  const quota = await httpProviderError(
    Response.json(
      { error: { code: 'insufficient_quota', message: 'Quota exhausted' } },
      { status: 429 },
    ),
    config,
  );
  assert.match(quota.message, /额度不足/);
});

test('HTTP response bodies retain unrecognized JSON fields and redact decoded credentials and request echoes', async () => {
  const secret = 'private-"key\nvalue';
  const body = {
    detail: 'The account has no available credits',
    info: { trace: 'trace-42', apiKey: 'unknown-credential', password: 'unknown-password' },
    echoedKey: secret,
    prompt: 'private prompt',
    input: ['private input'],
    systemPrompt: 'private instructions',
    requestBody: { text: 'private request body' },
  };
  const error = await httpProviderError(Response.json(body, { status: 402 }), {
    ...config,
    apiKey: secret,
  });
  assert.equal(error.details?.message, undefined);
  assert.equal(error.details?.status, 402);
  assert.deepEqual(JSON.parse(error.details!.responseBody!), {
    detail: body.detail,
    info: { trace: 'trace-42', apiKey: '[已隐藏]', password: '[已隐藏]' },
    echoedKey: '[已隐藏]',
    prompt: '[已省略请求内容]',
    input: '[已省略请求内容]',
    systemPrompt: '[已省略请求内容]',
    requestBody: '[已省略请求内容]',
  });
  assert.ok(v.safeParse(providerFailureSchema, error.details).success);
});

test('empty HTTP bodies are omitted and incomplete JSON bodies still remove escaped credentials and request echoes', async () => {
  const empty = await httpProviderError(new Response(null, { status: 500 }), config);
  assert.equal(empty.details?.responseBody, undefined);
  assert.equal(empty.details?.truncated, undefined);
  const secret = 'private-"key\nvalue';
  const incomplete = await httpProviderError(
    new Response(`{"detail":${JSON.stringify(secret)},"prompt":"private prompt`, { status: 502 }),
    { ...config, apiKey: secret },
  );
  assert.match(incomplete.details?.responseBody ?? '', /\[已隐藏\]/);
  assert.ok(!incomplete.details?.responseBody?.includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(!incomplete.details?.responseBody?.includes('private prompt'));
});

test('plain text and HTML errors remain text, and huge or stalled response bodies are bounded and cancelled', async () => {
  const plain = await httpProviderError(new Response('Gateway timed out', { status: 504 }), config);
  assert.equal(plain.details?.message, 'Gateway timed out');
  assert.equal(plain.details?.responseBody, 'Gateway timed out');
  const html = await httpProviderError(
    new Response('<html><body>private-test-key<script>boom()</script></body></html>', {
      status: 502,
    }),
    config,
  );
  assert.equal(html.details?.message, '供应商返回 HTML 错误页面。');
  assert.equal(
    html.details?.responseBody,
    '<html><body>[已隐藏]<script>boom()</script></body></html>',
  );
  let cancelled = false;
  const large = await httpProviderError(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('请求过多🙂'.repeat(20_000)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    ),
    config,
  );
  assert.equal(cancelled, true);
  assert.equal(large.details?.truncated, true);
  assert.ok(new TextEncoder().encode(large.details!.responseBody).length <= 4096);
  assert.ok(!large.details!.responseBody!.includes('\ufffd'));
  assert.ok(new TextEncoder().encode(JSON.stringify(large.details)).length <= 8192);
  cancelled = false;
  const stalled = await httpProviderError(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    ),
    config,
  );
  assert.equal(cancelled, true);
  assert.equal(stalled.details?.truncated, true);
});

test('response body formatting and JSON escaping respect the total diagnostic budget', async () => {
  const formatted = await httpProviderError(
    Response.json(
      Array.from({ length: 1000 }, () => 0),
      { status: 500 },
    ),
    config,
  );
  assert.equal(formatted.details?.truncated, true);
  const escaped = await httpProviderError(
    Response.json({ message: 'a\t'.repeat(2000) + 'end' }, { status: 500 }),
    config,
  );
  assert.equal(escaped.details?.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(escaped.details)).length <= 8192);
  assert.ok(escaped.details?.responseBody);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${protocol} forwards normal events byte for byte across CR/LF and arbitrary UTF-8 splits`, async () => {
    for (const ending of ['\n', '\r', '\r\n']) {
      for (const width of [1, 2, 7, 1024]) {
        const wire =
          ': heartbeat\n\n' + providerStreams[protocol].partial + providerStreams[protocol].finish;
        const bytes = new TextEncoder().encode(wire.replace(/\r\n|\r|\n/g, ending));
        let offset = 0;
        const safe = safeProviderStream(
          new ReadableStream({
            pull(controller) {
              if (offset === bytes.length) controller.close();
              else {
                controller.enqueue(bytes.slice(offset, offset + width));
                offset = Math.min(bytes.length, offset + width);
              }
            },
          }),
          { ...config, provider: protocol },
          [],
        );
        const output = new Uint8Array(await new Response(safe).arrayBuffer());
        assert.deepEqual(output, bytes);
      }
    }
  });
  test(`${protocol} records HTTP details without retrying the actual provider`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json(
        { error: { code: 'invalid_api_key', message: 'Invalid private-test-key' } },
        { status: 401, headers: { 'request-id': 'request-401' } },
      );
    });
    await assert.rejects(
      () => openProviderStream({ ...config, provider: protocol }, [], new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.details?.status, 401);
        assert.equal(error.details?.protocol, protocol);
        assert.equal(error.details?.requestId, 'request-401');
        assert.equal(error.details?.message, 'Invalid [已隐藏]');
        assert.match(error.details?.responseBody ?? '', /Invalid \[已隐藏\]/);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
  test(`${protocol} strips fragmented stream errors before public wire bytes and retains preceding text and thoughts`, async (t) => {
    const upstream =
      providerStreams[protocol].partial +
      `data: ${JSON.stringify(
        protocol === 'openai-responses'
          ? {
              type: 'response.failed',
              response: {
                error: {
                  code: 'server_error',
                  message: 'Retry later private-test-key private question',
                },
              },
            }
          : {
              type: 'error',
              error: {
                code: 'server_error',
                message: 'Retry later private-test-key private question',
              },
            },
      )}\r\n\r\n` +
      providerStreams[protocol].finish;
    const bytes = new TextEncoder().encode(upstream);
    let index = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (index === bytes.length) controller.close();
              else controller.enqueue(bytes.slice(index, ++index));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const body = await openProviderStream(
      { ...config, provider: protocol },
      [{ role: 'user', content: 'private question' }],
      new AbortController().signal,
    );
    const reader = body.getReader(),
      parser = new ProviderStream(protocol, true);
    let wire = '';
    await assert.rejects(
      async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          wire += new TextDecoder().decode(next.value);
          parser.feed(next.value);
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.details?.stage, 'stream');
        assert.equal(error.details?.code, 'server_error');
        assert.equal(error.details?.message, 'Retry later [已隐藏] [已隐藏]');
        return true;
      },
    );
    assert.equal(parser.content, '**正文🙂**\n');
    assert.equal(parser.reasoning, '**思考🙂**\n');
    assert.ok(!wire.includes('private-test-key'));
    assert.ok(!wire.includes('server_error'));
    assert.ok(!wire.includes('答案。'));
  });
}

test('generation and backup diagnostic schema reject raw payloads, unsafe endpoints and invalid dates', () => {
  const failure = providerFailure(config, 'protocol', 'Invalid frame');
  assert.ok(v.safeParse(generationSchema, { usage: {}, usageIsFinal: false, failure }).success);
  for (const patch of [
    { request: { headers: 'secret' } },
    { endpoint: 'https://user:pass@example.test/?secret=1' },
    { occurredAt: Number.MAX_SAFE_INTEGER },
    { message: 'a'.repeat(4097) },
    { responseBody: 'a'.repeat(4097) },
  ])
    assert.equal(v.safeParse(providerFailureSchema, { ...failure, ...patch }).success, false);
});
