import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchPath, type Message } from '../shared/types';
import { messageContext } from '../worker/message-context';

const message = (id: string, role: Message['role'], parentId: string | null, revisionOf: string | null = null): Message => ({
  id, role, parentId, revisionOf, content: id, status: 'completed', createdAt: 1, runId: null, error: null,
});
const history = [
  message('question', 'user', null), message('answer', 'assistant', 'question'),
  message('followup', 'user', 'answer'), message('followup-answer', 'assistant', 'followup'),
  message('retry-answer', 'assistant', 'question', 'answer'),
  message('edited-root', 'user', null, 'question'), message('edited-root-answer', 'assistant', 'edited-root'),
];

test('a revised root has no chronological prefix from another branch', () => {
  assert.deepEqual(branchPath(history, 'edited-root-answer').map(({ id }) => id), ['edited-root', 'edited-root-answer']);
  assert.deepEqual(messageContext(history, null, 'edited question'), [{ role: 'user', content: 'edited question' }]);
  assert.deepEqual(messageContext(history, 'edited-root-answer', 'new followup').map(({ content }) => content), ['edited-root', 'edited-root-answer', 'new followup']);
});

test('retrying or editing a followup uses its own parent path, even after another branch was created', () => {
  const extended = [...history, message('retry-followup', 'user', 'retry-answer'), message('retry-followup-answer', 'assistant', 'retry-followup')];
  assert.deepEqual(messageContext(extended, 'answer', 'edit followup').map(({ content }) => content), ['question', 'answer', 'edit followup']);
  assert.deepEqual(messageContext(extended, 'retry-answer', 'retry followup').map(({ content }) => content), ['question', 'retry-answer', 'retry followup']);
});

test('a standalone root never inherits earlier messages and an unknown or broken path is rejected', () => {
  const root = message('separate-root', 'user', null);
  assert.deepEqual(branchPath([...history, root], root.id), [root]);
  assert.throws(() => branchPath(history, 'missing'), /不存在/);
  assert.throws(() => branchPath([message('broken', 'assistant', 'missing')], 'broken'), /父消息不存在/);
  assert.throws(() => branchPath([message('cycle-a', 'user', 'cycle-b'), message('cycle-b', 'assistant', 'cycle-a')], 'cycle-a'), /循环/);
});

test('provider context omits unfinished output and bounds a long branch without including siblings', () => {
  const messages: Message[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 30; index++) {
    const user = message(`user-${index}`, 'user', parent), assistant = message(`assistant-${index}`, 'assistant', user.id);
    user.content = 'u'.repeat(2000); assistant.content = 'a'.repeat(2000);
    messages.push(user, assistant); parent = assistant.id;
  }
  messages.push({ ...message('unfinished', 'assistant', 'user-29'), status: 'failed', content: 'failed output' });
  const context = messageContext(messages, parent, 'current');
  assert.equal(context.length, 41);
  assert.equal(context[0].role, 'user');
  assert.equal(context.at(-1)?.content, 'current');
  assert.equal(context.slice(0, -1).reduce((total, message) => total + message.content.length, 0), 80_000);
  assert.ok(!context.some(({ content }) => content === 'failed output'));
});

test('deletion keeps descendant parent links but excludes a deleted question and its answers from context', () => {
  const deletedQuestion = { ...history[0], content: '', deletedAt: 123 };
  const messages = [deletedQuestion, ...history.slice(1)];
  assert.deepEqual(branchPath(messages, 'followup-answer').map(({ id }) => id), ['question', 'answer', 'followup', 'followup-answer']);
  assert.deepEqual(messageContext(messages, 'followup-answer', 'next').map(({ content }) => content), ['followup', 'followup-answer', 'next']);
  const deletedAnswer = history.map((message) => message.id === 'answer' ? { ...message, content: '', deletedAt: 123 } : message);
  assert.deepEqual(messageContext(deletedAnswer, 'followup-answer', 'next').map(({ content }) => content), ['question', 'followup', 'followup-answer', 'next']);
});
