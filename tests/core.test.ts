import { messageParts, messageText } from '../shared/conversation/content';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange } from '../shared/streaming/apply-change';
import { branchPath } from '../shared/conversation/branch-path';
import { type Message } from '../shared/conversation/types';
import { generate } from './fixtures/generate';
import { providerConfigFromEnv } from '../worker/providers/config';
import type { Env } from '../worker/http/env';

const message: Message = { id: 'one', role: 'assistant', parts: messageParts('hello'), status: 'running', createdAt: 1, runId: 'run', parentId: 'parent', revisionOf: null, error: null };
test('replayed events are idempotent and sequence gaps trigger resync', () => {
  const first = applyChange({ seq: 0, messages: [] }, { type: 'change', seq: 1, messages: [message] });
  assert.deepEqual(applyChange(first, { type: 'change', seq: 1, messages: [message] }), first);
  const final = applyChange(first, { type: 'change', seq: 2, messages: [{ ...message, parts: messageParts('hello world'), status: 'completed' }] });
  assert.equal(final.messages.length, 1);
  assert.equal(messageText(final.messages[0]), 'hello world');
  assert.throws(() => applyChange(final, { type: 'change', seq: 4, messages: [message] }), /sequence gap/);
});
test('branch paths keep the selected answer and its conversation prefix', () => {
  const message = (id: string, role: Message['role'], parentId: string | null, revisionOf: string | null = null): Message => ({ id, role, parentId, revisionOf, parts: messageParts(id), status: 'completed', createdAt: 1, runId: null, error: null });
  const messages = [
    message('user-1', 'user', null),
    message('assistant-1', 'assistant', 'user-1'),
    message('user-2', 'user', 'assistant-1'),
    message('assistant-2', 'assistant', 'user-2'),
    message('assistant-1-retry', 'assistant', 'user-1', 'assistant-1'),
    message('user-3', 'user', 'assistant-1-retry'),
    message('assistant-3', 'assistant', 'user-3'),
  ];
  assert.deepEqual(branchPath(messages, 'assistant-2').map(({ id }) => id), ['user-1', 'assistant-1', 'user-2', 'assistant-2']);
  assert.deepEqual(branchPath(messages, 'assistant-3').map(({ id }) => id), ['user-1', 'assistant-1-retry', 'user-3', 'assistant-3']);
});
const provider = providerConfigFromEnv({ AI_PROVIDER: 'openai-chat', AI_BASE_URL: 'https://provider.example/v1', AI_API_KEY: 'private-key', AI_MODEL: 'test', SYSTEM_PROMPT: 'test', MAX_OUTPUT_TOKENS: '128' } as Env);
assert.ok(provider);
test('AI SDK provider preserves UTF-8 deltas from fragmented streams', async () => {
  const original = globalThis.fetch;
  const bytes = new TextEncoder().encode(': comment\r\n\r\ndata: {"id":"1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\ndata: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  let text = '';
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  try { await generate(provider, [{ role: 'user', content: '测试' }], async (delta) => { text += delta; }, new AbortController().signal); assert.equal(text, '你好'); }
  finally { globalThis.fetch = original; }
});
test('provider preserves deltas but rejects an incomplete stream without retrying', async () => {
  const original = globalThis.fetch;
  let calls = 0, text = '';
  globalThis.fetch = async () => { calls++; return new Response('data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"部分回答"},"finish_reason":null}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); };
  try {
    await assert.rejects(() => generate(provider, [{ role: 'user', content: '测试' }], async (delta) => { text += delta; }, new AbortController().signal), /生成期间返回错误|未正常完成回答/);
    assert.equal(calls, 1); assert.equal(text, '部分回答');
  } finally { globalThis.fetch = original; }
});
test('provider completes a valid stream and keeps upstream diagnostics private', async () => {
  const original = globalThis.fetch;
  let text = '';
  try {
    globalThis.fetch = async () => new Response('data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"完整回答"},"finish_reason":null}]}\n\ndata: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    await generate(provider, [{ role: 'user', content: '测试' }], async (delta) => { text += delta; }, new AbortController().signal);
    assert.equal(text, '完整回答');
    globalThis.fetch = async () => new Response('sensitive diagnostic private-key', { status: 401 });
    await assert.rejects(() => generate(provider, [{ role: 'user', content: '测试' }], async () => {}, new AbortController().signal), (error: Error) => error.message.includes('401') && !error.message.includes('private-key'));
  } finally { globalThis.fetch = original; }
});
