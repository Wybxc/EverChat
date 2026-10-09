import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, type Message } from '../shared/types';
import { generate, sseData } from '../worker/provider';
import type { Env } from '../worker/env';

const message: Message = { id: 'one', role: 'assistant', content: 'hello', status: 'running', createdAt: 1, runId: 'run', parentId: 'parent', revisionOf: null, error: null };
test('replayed events are idempotent and sequence gaps trigger resync', () => {
  const first = applyChange({ seq: 0, messages: [] }, { type: 'change', seq: 1, messages: [message] });
  assert.deepEqual(applyChange(first, { type: 'change', seq: 1, messages: [message] }), first);
  const final = applyChange(first, { type: 'change', seq: 2, messages: [{ ...message, content: 'hello world', status: 'completed' }] });
  assert.equal(final.messages.length, 1);
  assert.equal(final.messages[0].content, 'hello world');
  assert.throws(() => applyChange(final, { type: 'change', seq: 4, messages: [message] }), /sequence gap/);
});
test('SSE parser preserves fragmented UTF-8, CRLF, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(': comment\r\n\r\ndata: {"text":"你好"}\r\n\r\ndata: first\ndata: second\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  for await (const event of sseData(stream)) events.push(event);
  assert.deepEqual(events, ['{"text":"你好"}', 'first\nsecond', '[DONE]']);
});
test('SSE parser rejects incomplete final frames instead of claiming success', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"unfinished":')); controller.close(); } });
  await assert.rejects(async () => { for await (const _ of sseData(stream)) {} }, /意外结束/);
});

const provider = { AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://provider.example/v1', AI_API_KEY: 'private-key', AI_MODEL: 'test', SYSTEM_PROMPT: 'test', MAX_OUTPUT_TOKENS: '128' } as Env;
test('provider preserves deltas but rejects a premature end without retrying', async () => {
  const original = globalThis.fetch;
  let calls = 0, text = '';
  globalThis.fetch = async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); };
  try {
    await assert.rejects(() => generate(provider, [], async (delta) => { text += delta; }, new AbortController().signal), /提前结束/);
    assert.equal(calls, 1); assert.equal(text, '部分回答');
  } finally { globalThis.fetch = original; }
});
test('provider completes a valid stream and keeps upstream diagnostics private', async () => {
  const original = globalThis.fetch;
  let text = '';
  try {
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"完整回答"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    await generate(provider, [], async (delta) => { text += delta; }, new AbortController().signal);
    assert.equal(text, '完整回答');
    globalThis.fetch = async () => new Response('sensitive diagnostic private-key', { status: 401 });
    await assert.rejects(() => generate(provider, [], async () => {}, new AbortController().signal), (error: Error) => error.message.includes('401') && !error.message.includes('private-key'));
  } finally { globalThis.fetch = original; }
});
