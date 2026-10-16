import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig, ProviderKind } from '../../../shared/providers/types';
import { generate } from '../../support/providers/consume-stream';

const config: ProviderConfig = {
  provider: 'openai-chat',
  baseUrl: 'https://provider.example/v1',
  model: 'test-model',
  systemPrompt: '系统提示',
  maxOutputTokens: 128,
  apiKey: 'private-key',
};

const history = [
  { role: 'user' as const, content: '历史问题' },
  { role: 'assistant' as const, content: '历史回答' },
  { role: 'user' as const, content: '新问题' },
];

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

const streams: Record<
  ProviderKind,
  { partial: string; finish: string; endpoint: string; keyHeader: string }
> = {
  'openai-chat': {
    partial: frame({
      id: 'chat',
      choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
    }),
    finish:
      frame({ id: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\r\n\r\n',
    endpoint: '/v1/chat/completions',
    keyHeader: 'authorization',
  },
  'openai-responses': {
    partial:
      frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'message' },
      }) +
      frame({
        type: 'response.output_text.delta',
        item_id: 'message',
        output_index: 0,
        delta: '你好',
      }),
    finish: frame({ type: 'response.completed', response: { incomplete_details: null } }),
    endpoint: '/v1/responses',
    keyHeader: 'authorization',
  },
  anthropic: {
    partial:
      frame({
        type: 'message_start',
        message: { id: 'message', model: 'test-model', usage: { input_tokens: 10 } },
      }) +
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
    finish:
      frame({ type: 'content_block_stop', index: 0 }) +
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      }) +
      frame({ type: 'message_stop' }),
    endpoint: '/v1/messages',
    keyHeader: 'x-api-key',
  },
  gemini: {
    partial: frame({ candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] }),
    finish: frame({ candidates: [{ finishReason: 'STOP' }] }),
    endpoint: '/v1/models/test-model:streamGenerateContent',
    keyHeader: 'x-goog-api-key',
  },
};

for (const [kind, fixture] of Object.entries(streams)) {
  const provider = kind as ProviderKind;
  test(`${provider} sends history, credentials and limits and preserves fragmented UTF-8`, async (t) => {
    let calls = 0;
    const bytes = new TextEncoder().encode(
      ': keepalive\r\n\r\n' + fixture.partial + fixture.finish,
    );
    t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      calls++;
      const url = new URL(input);
      assert.equal(url.pathname, fixture.endpoint);
      assert.ok(!url.href.includes(config.apiKey!));
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get(fixture.keyHeader),
        fixture.keyHeader === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey,
      );
      const body = JSON.parse(init.body as string);
      if (provider === 'gemini') {
        assert.equal(url.searchParams.get('alt'), 'sse');
        assert.equal(body.systemInstruction.parts[0].text, config.systemPrompt);
        assert.deepEqual(
          body.contents.map((item: { role: string }) => item.role),
          ['user', 'model', 'user'],
        );
        assert.equal(body.generationConfig.maxOutputTokens, 128);
      } else if (provider === 'anthropic') {
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(body.system[0].text, config.systemPrompt);
        assert.deepEqual(
          body.messages.map((item: { role: string }) => item.role),
          ['user', 'assistant', 'user'],
        );
        assert.equal(body.max_tokens, 128);
      } else if (provider === 'openai-responses') {
        assert.equal(body.store, false);
        assert.ok(JSON.stringify(body.input).includes(config.systemPrompt));
        assert.ok(JSON.stringify(body.input).includes('历史回答'));
        assert.equal(body.max_output_tokens, 128);
      } else {
        assert.deepEqual(body.stream_options, { include_usage: true });
        assert.equal(body.store, false);
        assert.equal(body.messages[0].content, config.systemPrompt);
        assert.deepEqual(
          body.messages.slice(1).map((item: { role: string }) => item.role),
          ['user', 'assistant', 'user'],
        );
        assert.equal(body.max_tokens, 128);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    let text = '';
    await generate(
      { ...config, provider },
      history,
      async (delta) => {
        text += delta;
      },
      new AbortController().signal,
    );
    assert.equal(text, '你好');
    assert.equal(calls, 1);
  });
  test(`${provider} rejects premature EOF, keeps partial output and never retries`, async (t) => {
    let calls = 0,
      text = '';
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(fixture.partial, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    await assert.rejects(() =>
      generate(
        { ...config, provider },
        history,
        async (delta) => {
          text += delta;
        },
        new AbortController().signal,
      ),
    );
    assert.equal(text, '你好');
    assert.equal(calls, 1);
  });
  test(`${provider} maps optional sampling controls to the actual supplier request`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (provider === 'gemini') {
        assert.equal(body.generationConfig.temperature, 0);
        assert.equal(body.generationConfig.topP, 0.8);
      } else {
        assert.equal(body.temperature, 0);
        assert.equal(body.top_p, provider === 'anthropic' ? undefined : 0.8);
      }
      return new Response(fixture.partial + fixture.finish, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    await generate(
      { ...config, provider, temperature: 0, topP: provider === 'anthropic' ? undefined : 0.8 },
      history,
      async () => {},
      new AbortController().signal,
    );
  });
  test(`${provider} uses provider defaults when no output limit is configured`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (provider === 'anthropic') {
        // Anthropic requires max_tokens; its SDK supplies the model's default maximum.
        assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 128);
      } else if (provider === 'gemini') assert.ok(!('maxOutputTokens' in body.generationConfig));
      else assert.ok(!('max_tokens' in body) && !('max_output_tokens' in body));
      return new Response(fixture.partial + fixture.finish, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    let text = '';
    await generate(
      { ...config, provider, maxOutputTokens: null },
      history,
      async (delta) => {
        text += delta;
      },
      new AbortController().signal,
    );
    assert.equal(text, '你好');
  });
  test(`${provider} keeps upstream diagnostics private and does not retry HTTP errors`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: 'private-key private diagnostic' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await assert.rejects(
      () =>
        generate({ ...config, provider }, history, async () => {}, new AbortController().signal),
      (error: Error) =>
        error.message.includes('429') &&
        !error.message.includes('private-key') &&
        !error.message.includes('private diagnostic'),
    );
    assert.equal(calls, 1);
  });
}
