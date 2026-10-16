import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { messageParts, messagePartsSchema, messageText } from '../shared/conversation/content';
import type { Message } from '../shared/conversation/types';
import { contextHistory } from '../shared/conversation/context-budget';
import { cachedSnapshot, writeChatCache as write } from '../src/features/chat/cache';

test('content parts preserve Markdown, Unicode and whitespace without duplicating either channel', () => {
  const answer = '\n**正文🙂**\n\u0000\\"', reasoning = '  **思考**\n';
  const parts = messageParts(answer, reasoning);
  assert.deepEqual(parts, [{ type: 'reasoning', text: reasoning }, { type: 'text', text: answer }]);
  assert.deepEqual(v.parse(messagePartsSchema, parts), parts);
  assert.equal(messageText({ parts }), answer); assert.equal(messageText({ parts }, 'reasoning'), reasoning);
  assert.deepEqual(messageParts(''), []);
  assert.deepEqual(messageParts('', reasoning), [{ type: 'reasoning', text: reasoning }]);
  assert.deepEqual(messageParts(answer), [{ type: 'text', text: answer }]);
});

test('parts reject unsupported types, empty or oversized text, extra fields and noncanonical repeated channels', () => {
  for (const parts of [null, [{ type: 'tool', text: 'x' }], [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'x'.repeat(100_001) }], [{ type: 'text', text: 'x', apiKey: 'secret' }],
    [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }],
    [{ type: 'reasoning', text: 'a' }, { type: 'reasoning', text: 'b' }]]) {
    assert.equal(v.safeParse(messagePartsSchema, parts).success, false);
  }
  assert.equal(v.safeParse(messagePartsSchema, messageParts('x'.repeat(100_000), 'y'.repeat(100_000))).success, true);
});

test('provider context uses answer parts and never replays private reasoning as conversational text', () => {
  const user: Message = { id: 'user', role: 'user', parts: messageParts('question'), status: 'completed',
    createdAt: 1, runId: null, parentId: null, revisionOf: null, error: null };
  const answer: Message = { ...user, id: 'answer', role: 'assistant', parentId: user.id, parts: messageParts('answer', 'private reasoning') };
  assert.deepEqual(contextHistory([user, answer], answer.id), [
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' },
  ]);
});

test('snapshot caches use the current DTO key and refetch instead of decoding an obsolete cached shape', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const id = crypto.randomUUID();
    values.set(`everchat:snapshot:${id}`, JSON.stringify({ seq: 3, messages: [{ content: 'obsolete' }] }));
    assert.deepEqual(cachedSnapshot(id), { seq: 0, messages: [] });
    const snapshot = { seq: 4, messages: [{ id: 'user', role: 'user' as const, parts: messageParts('current'), status: 'completed' as const,
      createdAt: 1, runId: null, parentId: null, revisionOf: null, error: null }] };
    write(`snapshot:${id}`, snapshot);
    assert.deepEqual(cachedSnapshot(id), snapshot);
    assert.deepEqual(JSON.parse(values.get(`everchat:snapshot:parts-v1:${id}`)!), snapshot);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
