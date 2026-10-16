import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig,ProviderKind } from '../../../shared/providers/types';
import { GenerationCancelled } from '../../../worker/providers/stream';
import { generate } from '../../support/providers/consume-stream';

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
