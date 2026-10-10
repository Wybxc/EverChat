import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig, ProviderKind } from '../shared/types';
import { generate, GenerationCancelled } from '../worker/provider';
import { mergeProviderConfig, providerConfigFromEnv, publicProviderSettings } from '../worker/provider-config';
import type { Env } from '../worker/env';

const config: ProviderConfig = { provider: 'openai-chat', baseUrl: 'https://provider.example/v1', model: 'test-model', systemPrompt: '系统提示', maxOutputTokens: 128, apiKey: 'private-key' };
const history = [{ role: 'user' as const, content: '历史问题' }, { role: 'assistant' as const, content: '历史回答' }, { role: 'user' as const, content: '新问题' }];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const streams: Record<Exclude<ProviderKind, 'demo'>, { partial: string; finish: string; endpoint: string; keyHeader: string }> = {
  'openai-chat': {
    partial: frame({ id: 'chat', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] }),
    finish: frame({ id: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n',
    endpoint: '/v1/chat/completions', keyHeader: 'authorization',
  },
  'openai-responses': {
    partial: frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message' } }) + frame({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, delta: '你好' }),
    finish: frame({ type: 'response.completed', response: { incomplete_details: null } }),
    endpoint: '/v1/responses', keyHeader: 'authorization',
  },
  anthropic: {
    partial: frame({ type: 'message_start', message: { id: 'message', model: 'test-model', usage: { input_tokens: 10 } } }) + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
    finish: frame({ type: 'content_block_stop', index: 0 }) + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) + frame({ type: 'message_stop' }),
    endpoint: '/v1/messages', keyHeader: 'x-api-key',
  },
  gemini: {
    partial: frame({ candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] }),
    finish: frame({ candidates: [{ finishReason: 'STOP' }] }),
    endpoint: '/v1/models/test-model:streamGenerateContent', keyHeader: 'x-goog-api-key',
  },
};

for (const [kind, fixture] of Object.entries(streams)) {
  const provider = kind as Exclude<ProviderKind, 'demo'>;
  test(`${provider} sends history, credentials and limits and preserves fragmented UTF-8`, async (t) => {
    let calls = 0;
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\n' + fixture.partial + fixture.finish);
    t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      calls++;
      const url = new URL(input);
      assert.equal(url.pathname, fixture.endpoint);
      assert.ok(!url.href.includes(config.apiKey!));
      const headers = new Headers(init.headers);
      assert.equal(headers.get(fixture.keyHeader), fixture.keyHeader === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey);
      const body = JSON.parse(init.body as string);
      if (provider === 'gemini') {
        assert.equal(url.searchParams.get('alt'), 'sse');
        assert.equal(body.systemInstruction.parts[0].text, config.systemPrompt);
        assert.deepEqual(body.contents.map((item: { role: string }) => item.role), ['user', 'model', 'user']);
        assert.equal(body.generationConfig.maxOutputTokens, 128);
      } else if (provider === 'anthropic') {
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(body.system[0].text, config.systemPrompt);
        assert.deepEqual(body.messages.map((item: { role: string }) => item.role), ['user', 'assistant', 'user']);
        assert.equal(body.max_tokens, 128);
      } else if (provider === 'openai-responses') {
        assert.equal(body.store, false);
        assert.ok(JSON.stringify(body.input).includes(config.systemPrompt));
        assert.ok(JSON.stringify(body.input).includes('历史回答'));
        assert.equal(body.max_output_tokens, 128);
      } else {
        assert.equal(body.store, false);
        assert.equal(body.messages[0].content, config.systemPrompt);
        assert.deepEqual(body.messages.slice(1).map((item: { role: string }) => item.role), ['user', 'assistant', 'user']);
        assert.equal(body.max_tokens, 128);
      }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    let text = '';
    await generate({ ...config, provider }, history, async (delta) => { text += delta; }, new AbortController().signal);
    assert.equal(text, '你好'); assert.equal(calls, 1);
  });
  test(`${provider} rejects premature EOF, keeps partial output and never retries`, async (t) => {
    let calls = 0, text = '';
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(fixture.partial, { headers: { 'Content-Type': 'text/event-stream' } }); });
    await assert.rejects(() => generate({ ...config, provider }, history, async (delta) => { text += delta; }, new AbortController().signal));
    assert.equal(text, '你好'); assert.equal(calls, 1);
  });
  test(`${provider} keeps upstream diagnostics private and does not retry HTTP errors`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error: { message: 'private-key private diagnostic' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }); });
    await assert.rejects(() => generate({ ...config, provider }, history, async () => {}, new AbortController().signal), (error: Error) => error.message.includes('429') && !error.message.includes('private-key') && !error.message.includes('private diagnostic'));
    assert.equal(calls, 1);
  });
}

test('provider changes cannot silently reuse credentials for a different endpoint', () => {
  const input = { ...config, apiKey: '', model: 'another-model' };
  assert.equal(mergeProviderConfig(config, input).apiKey, 'private-key');
  assert.throws(() => mergeProviderConfig(config, { ...input, baseUrl: 'https://another.example/v1' }), /重新填写/);
  assert.throws(() => mergeProviderConfig(config, { ...input, provider: 'anthropic' }), /重新填写/);
  assert.equal(mergeProviderConfig(config, { ...input, provider: 'gemini', apiKey: 'new-key' }).apiKey, 'new-key');
  assert.equal(mergeProviderConfig(config, { ...input, provider: 'demo' }).apiKey, undefined);
  assert.equal('apiKey' in publicProviderSettings(config), false);
  assert.equal(publicProviderSettings(config).hasApiKey, true);
});

test('settings reject invalid protocols, URL credentials, non-HTTPS and invalid limits', () => {
  for (const baseUrl of ['http://provider.example', 'file:///tmp/key', 'https://user:password@example.com', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'https://example.com/v1/responses']) {
    assert.throws(() => mergeProviderConfig(config, { ...config, baseUrl }));
  }
  for (const maxOutputTokens of [0, -1, 0.5, 100001]) assert.throws(() => mergeProviderConfig(config, { ...config, maxOutputTokens }));
  assert.throws(() => mergeProviderConfig(config, { ...config, provider: 'invalid' as ProviderKind }));
  assert.throws(() => mergeProviderConfig(config, { ...config, apiKey: 'key\nheader' }));
  assert.equal(providerConfigFromEnv({ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'env-model' } as Env).provider, 'openai-chat');
});

test('a cancelled checkpoint propagates cancellation rather than a supplier failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(streams['openai-responses'].partial + streams['openai-responses'].finish, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(() => generate({ ...config, provider: 'openai-responses' }, history, async () => { throw new GenerationCancelled(); }, new AbortController().signal), GenerationCancelled);
});
