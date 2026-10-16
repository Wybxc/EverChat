import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchPath } from '../../../shared/conversation/branch-path';
import { messageParts } from '../../../shared/conversation/content';
import { type Message } from '../../../shared/conversation/types';

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
