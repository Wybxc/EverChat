import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelMetadata } from '../shared/models/metadata';
import { assertWebToolSupport, publicWebUrl, validateWebToolCall, validateWebToolOutcome, type WebToolOutcome } from '../shared/web-tools/tasks';
import type { ProviderConfig, ProviderKind } from '../shared/providers/types';
import { collectProviderToolTurn, MAX_TOOL_TURN_WIRE_BYTES, providerToolPrompt, type ProviderToolExchange } from '../worker/provider-tools';
import { openProviderStream } from '../worker/provider';
import { fragmentedToolBody, toolQuery, toolStream } from './fixtures/tool-streams';

const kinds: ProviderKind[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
const enabled = ['web_search', 'read_webpage'] as const;
const metadata = resolveModelMetadata('openai-chat', { id: 'tool-fixture', name: 'Fixture', enabled: true, reasoningSupport: 'supported', metadataOverrides: { toolCalls: true } });
const configuration = (provider: ProviderKind): ProviderConfig => ({ provider, baseUrl: provider === 'openai-chat' ? 'https://api.deepseek.com/v1' : 'https://provider.example/v1',
  model: 'tool-fixture', systemPrompt: '系统指令', apiKey: 'private-fixture-key', maxOutputTokens: null, modelMetadata: metadata, reasoningEnabled: true, showReasoning: false });
const outcome = (id: string): WebToolOutcome => ({ id, name: 'web_search', status: 'completed', sources: [{ title: 'Cloudflare 文档', url: 'https://developers.cloudflare.com/', content: '资料正文🙂' }] });
const signal = () => new AbortController().signal;

for (const provider of kinds) test(`${provider} tool continuation preserves IDs, parameters and private reasoning metadata through a JSON checkpoint`, async (t) => {
  const config = configuration(provider), requests: Record<string, any>[] = [];
  const wire = toolStream(provider, { count: 2, redacted: true });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string)); return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
  });
  const initial = [{ role: 'user' as const, content: '查询最新资料' }];
  const first = await openProviderStream(config, initial, signal(), undefined, undefined, { enabled });
  assert.equal(await new Response(first).text(), wire, 'live supplier bytes remain untouched');
  const turn = await collectProviderToolTurn(config, enabled, fragmentedToolBody(wire), signal());
  assert.equal(requests.length, 1, 'saved-response parsing never calls the network');
  assert.equal(turn.finishReason, 'tool-calls');
  assert.equal(turn.usage.inputTokens, 5); assert.equal(turn.usageIsFinal, true);
  assert.deepEqual(turn.calls, [0, 1].map((index) => ({ id: `call_${index}`, name: 'web_search', input: { query: toolQuery } })));
  assert.equal(JSON.stringify(turn.calls).includes('signature'), false);
  const exchanges = JSON.parse(JSON.stringify([{ turn, outcomes: turn.calls.map((call) => outcome(call.id)) }])) as ProviderToolExchange[];
  const next = await openProviderStream(config, initial, signal(), undefined, undefined, { enabled, exchanges }); await next.cancel();
  assert.equal(requests.length, 2);
  const body = requests[1];
  if (provider === 'openai-chat') {
    const assistant = body.messages.find((message: any) => message.role === 'assistant');
    assert.equal(assistant.reasoning_content, '检索资料🙂');
    assert.deepEqual(assistant.tool_calls.map((call: any) => call.id), ['call_0', 'call_1']);
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { query: toolQuery });
    assert.deepEqual(body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id), ['call_0', 'call_1']);
    assert.equal(body.thinking.type, 'enabled');
  } else if (provider === 'openai-responses') {
    assert.equal(body.store, false); assert.ok(body.include.includes('reasoning.encrypted_content'));
    assert.equal(body.input.find((item: any) => item.type === 'reasoning').encrypted_content, 'encrypted-fixture');
    assert.deepEqual(body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id), ['call_0', 'call_1']);
    assert.equal(body.input.find((item: any) => item.type === 'item_reference'), undefined);
  } else if (provider === 'anthropic') {
    const assistant = body.messages.find((message: any) => message.role === 'assistant');
    assert.equal(assistant.content.find((part: any) => part.type === 'thinking').signature, 'fixture-signature');
    assert.equal(assistant.content.find((part: any) => part.type === 'redacted_thinking').data, 'redacted-fixture');
    assert.deepEqual(assistant.content.map((part: any) => part.type), ['thinking', 'redacted_thinking', 'tool_use', 'tool_use']);
    assert.deepEqual(body.messages.at(-1).content.map((part: any) => part.tool_use_id), ['call_0', 'call_1']);
  } else {
    const assistant = body.contents.find((message: any) => message.role === 'model');
    assert.equal(assistant.parts[0].thoughtSignature, 'fixture-signature');
    assert.deepEqual(body.contents.at(-1).parts.map((part: any) => part.functionResponse.id), ['call_0', 'call_1']);
  }
  assert.equal(JSON.stringify(body).includes('private-fixture-key'), false);
});

for (const provider of kinds) test(`${provider} rejects an incomplete tool stream and unknown tools without a model retry`, async () => {
  const config = configuration(provider), wire = toolStream(provider);
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(wire.slice(0, -20)), signal()), /完整|格式/);
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream(provider, { name: 'run_shell' })), signal()), /工具|验证/);
  await assert.rejects(collectProviderToolTurn(config, ['read_webpage'], fragmentedToolBody(wire), signal()), /工具|验证/);
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream(provider, { count: 3 })), signal()), /工具|调用/);
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream(provider, { duplicate: true, count: 2 })), signal()), /工具|重复|验证/);
});

test('invalid arguments, truncated calls and oversized continuation metadata cannot become executable calls', async () => {
  const config = configuration('openai-chat');
  for (const input of ['{', '{"query":""}', '{"query":"ok","command":"rm"}', JSON.stringify({ query: 'x'.repeat(9000) })]) {
    await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream('openai-chat', { input }), 101), signal()));
  }
  const limited = toolStream('openai-chat').replace('"finish_reason":"tool_calls"', '"finish_reason":"length"');
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(limited), signal()), /完整/);
  await assert.rejects(collectProviderToolTurn(configuration('anthropic'), enabled,
    fragmentedToolBody(toolStream('anthropic', { signature: Array(6).fill('x'.repeat(190_000)) }), 64 * 1024), signal()), /保存限制/);
});

test('bounded replay cancels oversized or stalled bodies and does not fetch remotely', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_TOOL_TURN_WIRE_BYTES + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(collectProviderToolTurn(configuration('openai-chat'), enabled, body, signal()), /大小限制|完整/);
  assert.equal(cancelled, true);
  for (const provider of kinds) {
    const abort = new AbortController(); cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const pending = collectProviderToolTurn(configuration(provider), enabled, stalled, abort.signal);
    abort.abort(); await assert.rejects(pending, /中断/); assert.equal(cancelled, true);
  }
});

test('continuation requires every result exactly once and pins provider identity and finite rounds', async () => {
  const config = configuration('anthropic'), turn = await collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream('anthropic')), signal());
  const exchange: ProviderToolExchange = { turn, outcomes: [outcome('call_0')] };
  assert.equal(providerToolPrompt([exchange], enabled, config).length, 2);
  for (const outcomes of [[], [outcome('wrong')], [outcome('call_0'), outcome('call_0')], [{ ...outcome('call_0'), name: 'read_webpage' }]]) {
    assert.throws(() => providerToolPrompt([{ turn, outcomes: outcomes as WebToolOutcome[] }], enabled, config), /不符/);
  }
  assert.throws(() => providerToolPrompt([exchange], enabled, { ...config, model: 'changed' }), /不符/);
  assert.throws(() => providerToolPrompt([exchange], enabled, { ...config, baseUrl: 'https://changed.example/v1' }), /不符/);
  assert.throws(() => providerToolPrompt([exchange], ['read_webpage'], config), /不符/);
  assert.throws(() => providerToolPrompt([exchange, exchange], enabled, config), /不符/);
  assert.throws(() => providerToolPrompt(Array(4).fill(exchange), enabled, config), /轮数/);
  const damaged = JSON.parse(JSON.stringify(turn)); damaged.content[0].providerOptions = {};
  assert.throws(() => providerToolPrompt([{ turn: damaged, outcomes: exchange.outcomes }], enabled, config), /不符/);
  const error = providerToolPrompt([{ turn, outcomes: [{ id: 'call_0', name: 'web_search', status: 'failed', error: '查询超时。' }] }], enabled, config);
  assert.deepEqual(error[1].content, [{ type: 'tool-result', toolCallId: 'call_0', toolName: 'web_search', output: { type: 'error-text', value: '查询超时。' } }]);
});

test('public tool inputs and sources reject credentials, local addresses and oversized or mismatched results', () => {
  assert.equal(publicWebUrl('https://developers.cloudflare.com/path?q=docs#section'), true);
  for (const url of ['http://example.org/', 'https://user:secret@example.org/', 'https://127.0.0.1/', 'https://[::1]/', 'https://0x7f000001/', 'https://localhost/',
    'https://private.local/', 'https://service.internal/', 'https://home.arpa/', 'https://example.org:8443/', 'https://a..org/', 'https://example.org/\n', 'https://example.org/\\path']) {
    assert.equal(publicWebUrl(url), false, url);
    assert.throws(() => validateWebToolCall({ id: 'call', name: 'read_webpage', input: { url } }, enabled));
  }
  assert.throws(() => validateWebToolOutcome({ ...outcome('call'), sources: [{ title: 'x', url: 'https://example.org/', content: 'x'.repeat(12_001) }] }));
  assert.throws(() => validateWebToolOutcome({ ...outcome('call'), sources: Array.from({ length: 5 }, () => ({
    title: '字'.repeat(300), url: 'https://example.org/' + '字'.repeat(2000), content: '字'.repeat(2400),
  })) }));
  assert.throws(() => validateWebToolOutcome({ ...outcome('call'), apiKey: 'not-allowed' }));
  assert.throws(() => assertWebToolSupport(undefined, enabled), /不支持/);
  assert.throws(() => assertWebToolSupport(metadata, []), /选择/);
});

test('official OpenAI Chat Completions uses the same bounded tool-result continuation', async (t) => {
  const config = { ...configuration('openai-chat'), baseUrl: 'https://api.openai.com/v1', reasoningEnabled: false };
  const turn = await collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream('openai-chat')), signal());
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests++;
    const body = JSON.parse(init.body as string);
    assert.equal(body.messages.find((message: any) => message.role === 'tool').tool_call_id, 'call_0');
    assert.equal(body.tools.length, 2); assert.equal(body.store, false);
    return new Response(toolStream('openai-chat'), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await openProviderStream(config, [{ role: 'user', content: 'search' }], signal(), undefined, undefined,
    { enabled, exchanges: [{ turn, outcomes: [outcome('call_0')] }] });
  await response.cancel(); assert.equal(requests, 1);
});

test('webpage reads preserve their exact input and ordinary final answers do not require another tool round', async () => {
  const config = configuration('openai-chat');
  const turn = await collectProviderToolTurn(config, ['read_webpage'], fragmentedToolBody(toolStream('openai-chat', { name: 'read_webpage', input: '{"url":"https://example.org/path?q=docs#text"}' })), signal());
  assert.deepEqual(turn.calls, [{ id: 'call_0', name: 'read_webpage', input: { url: 'https://example.org/path?q=docs#text' } }]);
  const wire = 'data: {"choices":[{"index":0,"delta":{"content":"完成🙂"}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const answer = await collectProviderToolTurn(config, enabled, fragmentedToolBody(wire, 1), signal());
  assert.equal(answer.finishReason, 'stop'); assert.deepEqual(answer.calls, []);
  assert.deepEqual(answer.content, [{ type: 'text', text: '完成🙂' }]);
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(wire.replace('完成🙂', '')), signal()), /文字回答/);
});

test('alternating reasoning and text blocks retain vendor order when the SDK reuses stream IDs', async () => {
  const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
  const wire = frame({ reasoning_content: '想一' }) + frame({ content: '说明一' }) + frame({ reasoning_content: '想二' }) + frame({ content: '说明二' })
    + toolStream('openai-chat').replace(/^data: .*?\n\n/, '');
  const turn = await collectProviderToolTurn(configuration('openai-chat'), enabled, fragmentedToolBody(wire), signal());
  assert.deepEqual(turn.content.slice(0, 4).map((part) => part.type === 'tool-call' ? part.toolName : part.text), ['想一', '说明一', '想二', '说明二']);
});

test('provider-declared tool execution and changed wire identities are rejected', async () => {
  const config = configuration('openai-chat');
  const base = toolStream('openai-chat');
  const changed = base.replace('"index":0,"function":{"arguments"', '"index":0,"id":"different","function":{"arguments"');
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(changed), signal()), /格式|验证/);
  const missing = base.replace('"id":"call_0",', '');
  await assert.rejects(collectProviderToolTurn(config, enabled, fragmentedToolBody(missing), signal()), /格式|验证/);
  const builtIn = toolStream('openai-responses').replace('"type":"function_call","id":"fc_0"', '"type":"web_search_call","id":"fc_0"');
  await assert.rejects(collectProviderToolTurn(configuration('openai-responses'), enabled, fragmentedToolBody(builtIn), signal()));
});

test('unfinished content blocks and missing signed reasoning cannot be saved as resumable tool turns', async () => {
  await assert.rejects(collectProviderToolTurn(configuration('anthropic'), enabled, fragmentedToolBody(toolStream('anthropic', { signature: [] })), signal()), /完整推理资料/);
  const openBlock = toolStream('anthropic').replace('data: {"type":"content_block_stop","index":0}\n\n', '');
  await assert.rejects(collectProviderToolTurn(configuration('anthropic'), enabled, fragmentedToolBody(openBlock), signal()), /完整/);
  const missingEncrypted = toolStream('openai-responses').replace('"encrypted_content":"encrypted-fixture"', '"encrypted_content":null');
  await assert.rejects(collectProviderToolTurn(configuration('openai-responses'), enabled, fragmentedToolBody(missingEncrypted), signal()), /完整推理资料/);
});

test('missing model metadata and invalid saved results fail before any supplier request', async (t) => {
  let requests = 0; t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('not expected'); });
  const config = configuration('openai-chat'), context = [{ role: 'user' as const, content: 'hello' }];
  await assert.rejects(openProviderStream({ ...config, modelMetadata: undefined }, context, signal(), undefined, undefined, { enabled }), /不支持/);
  const turn = await collectProviderToolTurn(config, enabled, fragmentedToolBody(toolStream('openai-chat')), signal());
  await assert.rejects(openProviderStream(config, context, signal(), undefined, undefined, { enabled, exchanges: [{ turn, outcomes: [] }] }), /不符/);
  assert.equal(requests, 0);
});
