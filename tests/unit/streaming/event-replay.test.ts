import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageParts,messageText } from '../../../shared/conversation/content';
import { type Message } from '../../../shared/conversation/types';
import { applyChange } from '../../../shared/streaming/apply-change';

const message: Message = { id: 'one', role: 'assistant', parts: messageParts('hello'), status: 'running', createdAt: 1, runId: 'run', parentId: 'parent', revisionOf: null, error: null };

test('replayed events are idempotent and sequence gaps trigger resync', () => {
  const first = applyChange({ seq: 0, messages: [] }, { type: 'change', seq: 1, messages: [message] });
  assert.deepEqual(applyChange(first, { type: 'change', seq: 1, messages: [message] }), first);
  const final = applyChange(first, { type: 'change', seq: 2, messages: [{ ...message, parts: messageParts('hello world'), status: 'completed' }] });
  assert.equal(final.messages.length, 1);
  assert.equal(messageText(final.messages[0]), 'hello world');
  assert.throws(() => applyChange(final, { type: 'change', seq: 4, messages: [message] }), /sequence gap/);
});
