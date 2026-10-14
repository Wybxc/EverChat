import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig, ProviderKind, ProviderSettingsInput } from '../shared/types';
import { GenerationCancelled } from '../worker/provider';
import { generate } from './fixtures/generate';
import { defaultProviderSettings, mergeProviderSettings, providerConfigFromEnv, publicProviderSettings, runtimeProviderConfig } from '../worker/provider-config';
import { fetchProviderModels } from '../worker/provider-models';
import type { Env } from '../worker/env';

const config: ProviderConfig = { provider: 'openai-chat', baseUrl: 'https://provider.example/v1', model: 'test-model', systemPrompt: '系统提示', maxOutputTokens: 128, apiKey: 'private-key' };
const history = [{ role: 'user' as const, content: '历史问题' }, { role: 'assistant' as const, content: '历史回答' }, { role: 'user' as const, content: '新问题' }];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const streams: Record<ProviderKind, { partial: string; finish: string; endpoint: string; keyHeader: string }> = {
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
  const provider = kind as ProviderKind;
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
  test(`${provider} maps optional sampling controls to the actual supplier request`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (provider === 'gemini') {
        assert.equal(body.generationConfig.temperature, 0); assert.equal(body.generationConfig.topP, 0.8);
      } else { assert.equal(body.temperature, 0); assert.equal(body.top_p, provider === 'anthropic' ? undefined : 0.8); }
      return new Response(fixture.partial + fixture.finish, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    await generate({ ...config, provider, temperature: 0, topP: provider === 'anthropic' ? undefined : 0.8 }, history, async () => {}, new AbortController().signal);
  });
  test(`${provider} uses provider defaults when no output limit is configured`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (provider === 'anthropic') {
        // Anthropic requires max_tokens; its SDK supplies the model's default maximum.
        assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 128);
      } else if (provider === 'gemini') assert.ok(!('maxOutputTokens' in body.generationConfig));
      else assert.ok(!('max_tokens' in body) && !('max_output_tokens' in body));
      return new Response(fixture.partial + fixture.finish, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    let text = '';
    await generate({ ...config, provider, maxOutputTokens: null }, history, async (delta) => { text += delta; }, new AbortController().signal);
    assert.equal(text, '你好');
  });
  test(`${provider} keeps upstream diagnostics private and does not retry HTTP errors`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error: { message: 'private-key private diagnostic' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }); });
    await assert.rejects(() => generate({ ...config, provider }, history, async () => {}, new AbortController().signal), (error: Error) => error.message.includes('429') && !error.message.includes('private-key') && !error.message.includes('private diagnostic'));
    assert.equal(calls, 1);
  });
}

const profileId = '00000000-0000-4000-8000-000000000012';
const settings = {
  providers: [{ id: profileId, name: 'Test', provider: 'openai-chat' as const, baseUrl: 'https://provider.example/v1', models: [{ id: 'test-model', name: '测试模型', enabled: true }], apiKey: 'private-key' }],
  activeProviderId: profileId, activeModel: 'test-model', systemPrompt: 'system', maxOutputTokens: 128, showReasoning: false,
};

test('output limits default to unset while explicit configured limits remain available', () => {
  const env = { AI_PROVIDER: 'openai-chat', AI_MODEL: 'test-model', AI_API_KEY: 'private-key' } as Env;
  assert.equal(defaultProviderSettings({} as Env).maxOutputTokens, null);
  assert.equal(defaultProviderSettings(env).maxOutputTokens, null);
  assert.equal(providerConfigFromEnv(env)?.maxOutputTokens, null);
  assert.equal(defaultProviderSettings({ ...env, MAX_OUTPUT_TOKENS: '4096' }).maxOutputTokens, 4096);
  assert.equal(providerConfigFromEnv({ ...env, MAX_OUTPUT_TOKENS: '4096' })?.maxOutputTokens, 4096);
  assert.equal(runtimeProviderConfig(mergeProviderSettings(settings, { ...settings, maxOutputTokens: null }))?.maxOutputTokens, null);
  const { maxOutputTokens: _limit, ...omitted } = settings;
  assert.equal(mergeProviderSettings(settings, omitted).maxOutputTokens, null);
  assert.equal(mergeProviderSettings(settings, settings).maxOutputTokens, 128);
});

test('provider profiles retain keys only for the same endpoint and return saved keys to settings', () => {
  const blankKey = { ...settings, providers: [{ ...settings.providers[0], apiKey: '' }] };
  assert.equal(mergeProviderSettings(settings, blankKey).providers[0].apiKey, 'private-key');
  assert.throws(() => mergeProviderSettings(settings, { ...blankKey, providers: [{ ...blankKey.providers[0], baseUrl: 'https://another.example/v1' }] }), /默认模型/);
  assert.throws(() => mergeProviderSettings(settings, { ...blankKey, providers: [{ ...blankKey.providers[0], provider: 'anthropic' }] }), /默认模型/);
  const moved = mergeProviderSettings(settings, { ...blankKey, activeProviderId: null, activeModel: '', providers: [{ ...blankKey.providers[0], baseUrl: 'https://another.example/v1' }] });
  assert.equal(moved.providers[0].apiKey, undefined);
  assert.equal(publicProviderSettings(settings).providers[0].apiKey, 'private-key');
  assert.equal(publicProviderSettings(settings).providers[0].hasApiKey, true);
  assert.equal(providerConfigFromEnv({ AI_PROVIDER: 'openai-chat', AI_MODEL: 'env-model' } as Env)?.provider, 'openai-chat');
  assert.equal(runtimeProviderConfig({ ...settings, activeProviderId: null, activeModel: '' }), null);
});

test('missing model configuration cannot generate and unknown provider types are rejected', () => {
  assert.equal(providerConfigFromEnv({} as Env), null);
  assert.deepEqual(defaultProviderSettings({} as Env).providers, []);
  assert.throws(() => providerConfigFromEnv({ AI_PROVIDER: 'demo' } as Env), /AI_PROVIDER/);
  assert.throws(() => providerConfigFromEnv({ AI_PROVIDER: 'openai-compatible' } as Env), /AI_PROVIDER/);
  assert.equal(runtimeProviderConfig({ ...settings, providers: [{ ...settings.providers[0], apiKey: undefined }] }), null);
  assert.equal(runtimeProviderConfig({ ...settings, activeModel: 'missing-model' }), null);
});

test('enabled model names survive persistence while disabled models cannot generate', () => {
  const disabled = { ...settings, providers: [{ ...settings.providers[0], models: [{ id: 'test-model', name: '测试模型', enabled: false }] }] };
  assert.throws(() => mergeProviderSettings(settings, disabled), /必须已启用/);
  assert.equal(runtimeProviderConfig(disabled), null);
  const saved = mergeProviderSettings(settings, settings);
  assert.equal(runtimeProviderConfig(saved)?.model, 'test-model');
  assert.equal(runtimeProviderConfig(saved)?.modelName, '测试模型');
  const blankName = { ...settings, providers: [{ ...settings.providers[0], models: [{ id: 'test-model', name: '', enabled: true }] }] };
  assert.equal(runtimeProviderConfig(blankName)?.modelName, 'test-model');
  assert.throws(() => mergeProviderSettings(settings, { ...settings, providers: [{ ...settings.providers[0], models: ['test-model'] }] } as unknown as ProviderSettingsInput), /请检查/);
});

test('provider profiles reject insecure endpoints, duplicate models and invalid limits', () => {
  for (const baseUrl of ['http://provider.example', 'file:///tmp/key', 'https://user:password@example.com', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'https://example.com/v1/responses']) {
    assert.throws(() => mergeProviderSettings(settings, { ...settings, providers: [{ ...settings.providers[0], baseUrl }] }));
  }
  for (const maxOutputTokens of [0, -1, 0.5, 100001]) assert.throws(() => mergeProviderSettings(settings, { ...settings, maxOutputTokens }));
  assert.throws(() => mergeProviderSettings(settings, { ...settings, providers: [{ ...settings.providers[0], provider: 'invalid' as ProviderKind }] }));
  assert.throws(() => mergeProviderSettings(settings, { ...settings, providers: [{ ...settings.providers[0], apiKey: 'key\nheader' }] }));
  assert.throws(() => mergeProviderSettings(settings, { ...settings, providers: [{ ...settings.providers[0], models: [{ id: 'same', name: 'same', enabled: true }, { id: 'same', name: 'same', enabled: true }] }] }));
});

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${provider} fetches and normalizes its authenticated model list`, async (t) => {
    const profile = { ...settings.providers[0], provider, apiKey: 'private-key' };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      assert.equal(init?.redirect, 'manual');
      assert.equal(url.pathname, '/v1/models');
      if (provider === 'anthropic') {
        assert.equal(headers.get('x-api-key'), 'private-key'); assert.equal(headers.get('anthropic-version'), '2023-06-01');
        return Response.json({ data: [{ id: 'claude-sonnet' }, { id: 'claude-haiku' }] });
      }
      if (provider === 'gemini') {
        assert.equal(headers.get('x-goog-api-key'), 'private-key'); assert.equal(url.searchParams.get('pageSize'), '1000');
        return Response.json({ models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        ] });
      }
      assert.equal(headers.get('authorization'), 'Bearer private-key');
      return Response.json({ data: [{ id: 'gpt-z' }, { id: 'gpt-a' }, { id: 'gpt-z' }] });
    });
    const ids = await fetchProviderModels(profile);
    assert.deepEqual(ids, provider === 'anthropic' ? ['claude-haiku', 'claude-sonnet'] : provider === 'gemini' ? ['gemini-2.5-flash'] : ['gpt-a', 'gpt-z']);
  });
}

test('model discovery sanitizes upstream errors and requires a stored key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'private-key diagnostics' } }, { status: 401 }));
  await assert.rejects(() => fetchProviderModels(settings.providers[0]), (error: Error) => error.message.includes('401') && !error.message.includes('private-key'));
  await assert.rejects(() => fetchProviderModels({ ...settings.providers[0], apiKey: undefined }), /API 密钥/);
});

test('a cancelled checkpoint propagates cancellation rather than a supplier failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(streams['openai-responses'].partial + streams['openai-responses'].finish, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(() => generate({ ...config, provider: 'openai-responses' }, history, async () => { throw new GenerationCancelled(); }, new AbortController().signal), GenerationCancelled);
});

test('DeepSeek reasoning uses its OpenAI-compatible fields and stays separate from the answer', async (t) => {
  const response = frame({ choices: [{ delta: { reasoning_content: '先分析。', content: '答案。' }, finish_reason: null }] }) +
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as { reasoning_effort?: string; thinking?: { type: string }; messages: { role: string; content: string }[] };
    assert.equal(new URL(request.url).hostname, 'api.deepseek.com');
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.ok(!JSON.stringify(body.messages).includes('先分析。'));
    return new Response(response, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let text = '', thought = '';
  await generate({ ...config, model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', reasoningEnabled: true, reasoningEffort: 'high', showReasoning: true }, history,
    async (delta) => { text += delta; }, new AbortController().signal, async (delta) => { thought += delta; });
  assert.equal(text, '答案。'); assert.equal(thought, '先分析。');
});

// Responses event structure captured from a real DeepSeek Flash request.
const deepseekResponses = (terminal = 'response.completed'): Array<{ type: string } & Record<string, unknown>> => [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'thought', summary: [], content: [] } },
  { type: 'response.content_part.added', item_id: 'thought', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } },
  { type: 'response.reasoning_text.delta', item_id: 'thought', output_index: 0, content_index: 0, delta: '**先分析' },
  { type: 'response.reasoning_text.delta', item_id: 'thought', output_index: 0, content_index: 0, delta: '。**' },
  { type: 'response.reasoning_text.done', item_id: 'thought', output_index: 0, content_index: 0, text: '**先分析。**' },
  { type: 'response.content_part.done', item_id: 'thought', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '**先分析。**' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'thought', summary: [], content: [{ type: 'reasoning_text', text: '**先分析。**' }] } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'answer' } },
  { type: 'response.output_text.delta', item_id: 'answer', output_index: 1, content_index: 0, delta: '答案。' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'answer' } },
  { type: terminal, response: { incomplete_details: terminal === 'response.incomplete' ? { reason: 'max_output_tokens' } : null } },
];

test('DeepSeek Responses streams reasoning_text before the answer without repeating done events', async (t) => {
  const received: string[] = [];
  const bytes = new TextEncoder().encode(deepseekResponses().map(frame).join(''));
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(new URL(input).pathname, '/responses');
    const body = JSON.parse(init.body as string);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.store, false);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await generate({ ...config, provider: 'openai-responses', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', reasoningEnabled: true, reasoningEffort: 'low', showReasoning: true }, history,
    async (delta) => { received.push(`text:${delta}`); }, new AbortController().signal, async (delta) => { received.push(`reasoning:${delta}`); });
  assert.deepEqual(received, ['reasoning:**先分析', 'reasoning:。**', 'text:答案。']);
});

test('compatible Responses keep native reasoning summaries and do not double append raw reasoning', async (t) => {
  const events = deepseekResponses();
  events.splice(4, 0, { type: 'response.reasoning_summary_text.delta', item_id: 'thought', output_index: 0, summary_index: 0, delta: '**先分析。**' });
  t.mock.method(globalThis, 'fetch', async () => new Response(events.map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
  let thought = '';
  await generate({ ...config, provider: 'openai-responses' }, history, async () => {}, new AbortController().signal, async (delta) => { thought += delta; });
  assert.equal(thought, '**先分析。**');

  const summaries = events.filter((event) => !event.type.startsWith('response.reasoning_text.'));
  t.mock.method(globalThis, 'fetch', async () => new Response(summaries.map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
  thought = '';
  await generate({ ...config, provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }, history, async () => {}, new AbortController().signal, async (delta) => { thought += delta; });
  assert.equal(thought, '**先分析。**');
});

test('DeepSeek Responses preserves partial thoughts and propagates cancellation without retrying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(deepseekResponses().slice(0, 4).map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let thought = '';
  await assert.rejects(() => generate({ ...config, provider: 'openai-responses' }, history, async () => {}, new AbortController().signal, async (delta) => { thought += delta; }));
  assert.equal(thought, '**先分析。**');
  assert.equal(calls, 1);
  await assert.rejects(() => generate({ ...config, provider: 'openai-responses' }, history, async () => {}, new AbortController().signal, async () => { throw new GenerationCancelled(); }), GenerationCancelled);
  assert.equal(calls, 2);
});

test('model overrides pin their prompt and validate provider reasoning support', () => {
  const custom = { ...settings, showReasoning: true, systemPrompt: '统一', providers: [{
    ...settings.providers[0], models: [{ id: 'test-model', name: '测试模型', enabled: true,
      useGlobalSystemPrompt: false, systemPrompt: '专属', reasoningSupport: 'supported' as const }],
  }] };
  assert.equal(runtimeProviderConfig(custom)?.systemPrompt, '专属');
  assert.equal(runtimeProviderConfig(custom)?.reasoningEffort, undefined);
  assert.equal(runtimeProviderConfig(custom, undefined, 'high')?.reasoningEffort, 'high');
  assert.equal(runtimeProviderConfig(custom, undefined, 'max'), null);
  assert.equal(runtimeProviderConfig(custom)?.showReasoning, true);
  const unknownField = { ...custom, providers: [{ ...custom.providers[0], models: [{ ...custom.providers[0].models[0], reasoningEffort: 'high' }] }] };
  assert.equal(Object.hasOwn(mergeProviderSettings(custom, unknownField).providers[0].models[0], 'reasoningEffort'), false);
});
