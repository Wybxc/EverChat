import {
  MAX_MESSAGE_TEXT_BYTES,
  jsonTextBytes,
  textWithinBytes,
} from '../../../shared/conversation/limits';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
  messageParts,
  messagePartsSchema,
  messageText,
} from '../../../shared/conversation/content';
import { contextHistory } from '../../../shared/conversation/context-budget';
import type { Message } from '../../../shared/conversation/types';
import { cachedSnapshot, writeChatCache as write } from '../../../src/features/chat/cache';

test('content parts preserve Markdown, Unicode and whitespace without duplicating either channel', () => {
  const answer = '\n**正文🙂**\n\u0000\\"',
    reasoning = '  **思考**\n';
  const parts = messageParts(answer, reasoning);
  assert.deepEqual(parts, [
    { type: 'reasoning', text: reasoning },
    { type: 'text', text: answer },
  ]);
  assert.deepEqual(v.parse(messagePartsSchema, parts), parts);
  assert.equal(messageText({ parts }), answer);
  assert.equal(messageText({ parts }, 'reasoning'), reasoning);
  assert.deepEqual(messageParts(''), []);
  assert.deepEqual(messageParts('', reasoning), [{ type: 'reasoning', text: reasoning }]);
  assert.deepEqual(messageParts(answer), [{ type: 'text', text: answer }]);
});

test('parts reject unsupported types, empty or oversized text, extra fields and noncanonical repeated channels', () => {
  for (const parts of [
    null,
    [{ type: 'tool', text: 'x' }],
    [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'x'.repeat(MAX_MESSAGE_TEXT_BYTES + 1) }],
    [{ type: 'text', text: 'x', apiKey: 'secret' }],
    [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    [
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'b' },
    ],
    [
      { type: 'reasoning', text: 'a' },
      { type: 'reasoning', text: 'b' },
    ],
  ]) {
    assert.equal(v.safeParse(messagePartsSchema, parts).success, false);
  }
  assert.equal(
    v.safeParse(messagePartsSchema, messageParts('x'.repeat(100_000), 'y'.repeat(100_000))).success,
    true,
  );
});

test('provider context uses answer parts and never replays private reasoning as conversational text', () => {
  const user: Message = {
    id: 'user',
    role: 'user',
    parts: messageParts('question'),
    status: 'completed',
    createdAt: 1,
    runId: null,
    parentId: null,
    revisionOf: null,
    error: null,
  };
  const answer: Message = {
    ...user,
    id: 'answer',
    role: 'assistant',
    parentId: user.id,
    parts: messageParts('answer', 'private reasoning'),
  };
  assert.deepEqual(contextHistory([user, answer], answer.id), [
    { role: 'user', content: 'question', source: { kind: 'message', messageId: 'user' } },
    { role: 'assistant', content: 'answer', source: { kind: 'message', messageId: 'answer' } },
  ]);
});

test('snapshot caches use the current DTO key and refetch instead of decoding an obsolete cached shape', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const id = crypto.randomUUID();
    values.set(
      `everchat:snapshot:${id}`,
      JSON.stringify({ seq: 3, messages: [{ content: 'obsolete' }] }),
    );
    assert.deepEqual(cachedSnapshot(id), { seq: 0, messages: [] });
    const snapshot = {
      seq: 4,
      messages: [
        {
          id: 'user',
          role: 'user' as const,
          parts: messageParts('current'),
          status: 'completed' as const,
          createdAt: 1,
          runId: null,
          parentId: null,
          revisionOf: null,
          error: null,
        },
      ],
    };
    write(`snapshot:${id}`, snapshot);
    assert.deepEqual(cachedSnapshot(id), snapshot);
    assert.deepEqual(JSON.parse(values.get(`everchat:snapshot:parts-v1:${id}`)!), snapshot);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('message byte budgets include JSON escaping and combine answer and reasoning', () => {
  const budget = MAX_MESSAGE_TEXT_BYTES;
  assert.ok(
    v.safeParse(messagePartsSchema, messageParts('文'.repeat(150_000), '思'.repeat(100_000)))
      .success,
  );
  assert.ok(v.safeParse(messagePartsSchema, messageParts('x'.repeat(budget))).success);
  assert.equal(
    v.safeParse(messagePartsSchema, messageParts('x'.repeat(budget), 'y')).success,
    false,
  );
  assert.equal(
    v.safeParse(messagePartsSchema, messageParts('\u0000'.repeat(Math.floor(budget / 6) + 1)))
      .success,
    false,
  );
  for (const text of ['a文🙂\u0000"\\', '\ud83d', '\ude00', '🙂🙂', '\n\t\r']) {
    for (let size = 0; size < 40; size++) {
      const prefix = textWithinBytes(text, size);
      assert.ok(text.startsWith(prefix));
      assert.ok(jsonTextBytes(prefix) <= size);
      if (prefix.length < text.length && /[\uDC00-\uDFFF]/.test(text[prefix.length]))
        assert.doesNotMatch(prefix, /[\uD800-\uDBFF]$/u);
    }
  }
});
