import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../../../shared/conversation/types';
import { lastConversationModel } from '../../../src/features/chat/useChatModel';

const answer = (createdAt: number, providerId = 'first', model = 'shared'): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  parts: [],
  status: 'completed',
  createdAt,
  runId: null,
  parentId: null,
  revisionOf: null,
  error: null,
  providerId,
  model,
});

test('model restoration uses the newest answer across branches and keeps the provider identity', () => {
  assert.deepEqual(lastConversationModel([answer(30, 'second'), answer(10), answer(20)]), {
    providerId: 'second',
    model: 'shared',
  });
});

test('summaries, user messages, deleted answers and missing identities do not change the chat model', () => {
  assert.deepEqual(
    lastConversationModel([
      answer(10),
      { ...answer(20, 'other'), role: 'user' },
      { ...answer(30, 'other'), deletedAt: 31 },
      { ...answer(40, 'other'), summary: { throughId: 'old-answer', sourceIds: ['old-answer'] } },
      { ...answer(50, 'other'), model: null },
      { ...answer(60, 'other'), providerId: null },
    ]),
    { providerId: 'first', model: 'shared' },
  );
  assert.equal(lastConversationModel([]), undefined);
});

test('the latest attempted model is retained for running, failed and interrupted generations', () => {
  for (const status of ['running', 'failed', 'cancelled', 'completed'] as const)
    assert.deepEqual(lastConversationModel([answer(10), { ...answer(20, 'second'), status }]), {
      providerId: 'second',
      model: 'shared',
    });
});

test('manual answer revisions do not replace the last model, but copied generated revisions do', () => {
  const manual = { ...answer(30, 'first'), revisionOf: 'original' };
  const history = [answer(10), answer(20, 'second'), manual];
  assert.deepEqual(lastConversationModel(history), { providerId: 'second', model: 'shared' });
  assert.deepEqual(
    lastConversationModel([
      ...history,
      {
        ...answer(40, 'third'),
        revisionOf: 'original',
        generation: { usage: {}, usageIsFinal: true },
      },
    ]),
    { providerId: 'third', model: 'shared' },
  );
});
