import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchPath } from '../../../shared/conversation/branch-path';
import { messageParts } from '../../../shared/conversation/content';
import { buildContext, contextHistory } from '../../../shared/conversation/context-budget';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import { type Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
const config = { systemPrompt: '', maxOutputTokens: null };
const messageContext = (messages: Message[], parentId: string | null, content: string) =>
  buildContext(contextHistory(messages, parentId), content, config, DEFAULT_CONVERSATION_SETTINGS)
    .messages;

const message = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  revisionOf: string | null = null,
): Message => ({
  id,
  role,
  parentId,
  revisionOf,
  parts: messageParts(id),
  status: 'completed',
  createdAt: 1,
  runId: null,
  error: null,
});
const history = [
  message('question', 'user', null),
  message('answer', 'assistant', 'question'),
  message('followup', 'user', 'answer'),
  message('followup-answer', 'assistant', 'followup'),
  message('retry-answer', 'assistant', 'question', 'answer'),
  message('edited-root', 'user', null, 'question'),
  message('edited-root-answer', 'assistant', 'edited-root'),
];

test('a revised root has no chronological prefix from another branch', () => {
  assert.deepEqual(
    branchPath(history, 'edited-root-answer').map(({ id }) => id),
    ['edited-root', 'edited-root-answer'],
  );
  assert.deepEqual(messageContext(history, null, 'edited question'), [
    { role: 'user', content: 'edited question' },
  ]);
  assert.deepEqual(
    messageContext(history, 'edited-root-answer', 'new followup').map(({ content }) => content),
    ['edited-root', 'edited-root-answer', 'new followup'],
  );
});

test('retrying or editing a followup uses its own parent path, even after another branch was created', () => {
  const extended = [
    ...history,
    message('retry-followup', 'user', 'retry-answer'),
    message('retry-followup-answer', 'assistant', 'retry-followup'),
  ];
  assert.deepEqual(
    messageContext(extended, 'answer', 'edit followup').map(({ content }) => content),
    ['question', 'answer', 'edit followup'],
  );
  assert.deepEqual(
    messageContext(extended, 'retry-answer', 'retry followup').map(({ content }) => content),
    ['question', 'retry-answer', 'retry followup'],
  );
});

test('a standalone root never inherits earlier messages and an unknown or broken path is rejected', () => {
  const root = message('separate-root', 'user', null);
  assert.deepEqual(branchPath([...history, root], root.id), [root]);
  assert.throws(() => branchPath(history, 'missing'), /不存在/);
  assert.throws(
    () => branchPath([message('broken', 'assistant', 'missing')], 'broken'),
    /父消息不存在/,
  );
  assert.throws(
    () =>
      branchPath(
        [message('cycle-a', 'user', 'cycle-b'), message('cycle-b', 'assistant', 'cycle-a')],
        'cycle-a',
      ),
    /循环/,
  );
});

test('provider context omits unfinished output and bounds a long branch without including siblings', () => {
  const messages: Message[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 30; index++) {
    const user = message(`user-${index}`, 'user', parent),
      assistant = message(`assistant-${index}`, 'assistant', user.id);
    user.parts = messageParts('u'.repeat(2000));
    assistant.parts = messageParts('a'.repeat(2000));
    messages.push(user, assistant);
    parent = assistant.id;
  }
  messages.push({
    ...message('unfinished', 'assistant', 'user-29'),
    status: 'failed',
    parts: messageParts('failed output'),
  });
  const built = buildContext(
    contextHistory(messages, parent),
    'current',
    config,
    DEFAULT_CONVERSATION_SETTINGS,
  );
  const context = built.messages;
  assert.ok(context.length < 61);
  assert.ok(built.estimate.totalTokens <= built.estimate.inputBudget);
  assert.ok(built.estimate.omittedMessages > 0);
  assert.equal(context[0].role, 'user');
  assert.equal(context.at(-1)?.content, 'current');
  assert.ok(!context.some(({ content }) => content === 'failed output'));
  const larger = buildContext(
    contextHistory(messages, parent),
    'current',
    {
      ...config,
      modelMetadata: resolveModelMetadata('openai-chat', {
        id: 'large',
        name: '',
        enabled: true,
        metadataOverrides: { contextWindow: 100_000 },
      }),
    },
    DEFAULT_CONVERSATION_SETTINGS,
  );
  assert.equal(larger.messages.length, 61);
  assert.equal(
    larger.messages.slice(0, -1).reduce((total, message) => total + message.content.length, 0),
    120_000,
  );
});

test('deletion keeps descendant parent links but excludes a deleted question and its answers from context', () => {
  const deletedQuestion = { ...history[0], parts: messageParts(''), deletedAt: 123 };
  const messages = [deletedQuestion, ...history.slice(1)];
  assert.deepEqual(
    branchPath(messages, 'followup-answer').map(({ id }) => id),
    ['question', 'answer', 'followup', 'followup-answer'],
  );
  assert.deepEqual(
    messageContext(messages, 'followup-answer', 'next').map(({ content }) => content),
    ['followup', 'followup-answer', 'next'],
  );
  const deletedAnswer = history.map((message) =>
    message.id === 'answer' ? { ...message, parts: messageParts(''), deletedAt: 123 } : message,
  );
  assert.deepEqual(
    messageContext(deletedAnswer, 'followup-answer', 'next').map(({ content }) => content),
    ['question', 'followup', 'followup-answer', 'next'],
  );
});
