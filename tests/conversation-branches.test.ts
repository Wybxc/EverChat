import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchChoices, branchIds, branchIndexer, continuationParent, descendBranch, indexBranches, recoverBranch, rememberBranch, summariesOnBranch } from '../shared/conversation/branches';
import { messageParts } from '../shared/conversation/content';
import type { Message } from '../shared/conversation/types';

const msg = (id: string, parentId: string | null, role: Message['role'] = 'assistant', extra: Partial<Message> = {}): Message => ({
  id, parentId, role, parts: messageParts(id), revisionOf: null, status: 'completed', createdAt: 1, runId: null, error: null, ...extra,
});
const tree = () => [msg('u', null, 'user'), msg('a1', 'u'), msg('a2', 'u', 'assistant', { revisionOf: 'a1' }),
  msg('u1', 'a1', 'user'), msg('b1', 'u1'), msg('u2', 'a1', 'user'), msg('b2', 'u2'), msg('b3', 'u2')];

test('sibling alternatives use parent edges, and paths contain only their own descendants', () => {
  const messages = tree(), index = indexBranches(messages);
  assert.deepEqual(branchChoices(index, 'a1'), ['a1', 'a2']);
  assert.deepEqual(branchChoices(index, 'u1'), ['u1', 'u2']); // No revisionOf needed.
  assert.deepEqual(branchIds(index, 'b1'), ['u', 'a1', 'u1', 'b1']);
  const preferences = rememberBranch(index, 'b1', {});
  assert.equal(descendBranch(index, 'a2', preferences), 'a2');
  assert.equal(descendBranch(index, 'a1', preferences), 'b1');
  assert.equal(descendBranch(index, 'u2', preferences), 'b3');
  assert.equal(rememberBranch(index, 'b1', preferences), preferences);
});

test('root edits, manual answer edits and repeated regeneration remain siblings in insertion order', () => {
  const messages = [...tree(), msg('a3', 'u', 'assistant', { revisionOf: 'a2' }), msg('u-edit', null, 'user', { revisionOf: 'u' }), msg('edit-answer', 'u-edit')];
  const index = indexBranches(messages);
  assert.deepEqual(branchChoices(index, 'a1'), ['a1', 'a2', 'a3']);
  assert.deepEqual(branchChoices(index, 'u'), ['u', 'u-edit']);
  assert.deepEqual(branchIds(index, 'edit-answer'), ['u-edit', 'edit-answer']);
});

test('deleted connectors preserve descendants, deleted leaves fall back to the previous then next version', () => {
  const messages = tree().map((message) => ['a1', 'b2', 'b3'].includes(message.id) ? { ...message, deletedAt: 2 } : message);
  const index = indexBranches(messages);
  assert(index.browsable.has('a1'));
  assert(!index.browsable.has('b2'));
  assert.equal(recoverBranch(index, 'b2', {}), 'u2');
  assert.equal(recoverBranch(indexBranches([msg('u', null, 'user'), msg('a1', 'u'), msg('a2', 'u', 'assistant', { deletedAt: 2 }), msg('a3', 'u')]), 'a2', {}), 'a1');
  assert.equal(recoverBranch(indexBranches([msg('u', null, 'user'), msg('a1', 'u', 'assistant', { deletedAt: 2 }), msg('a2', 'u')]), 'a1', {}), 'a2');
});

test('summaries are branch artifacts; failed and mixed-role continuations remain reachable', () => {
  const messages = [msg('u', null, 'user'), msg('failed', 'u', 'assistant', { status: 'failed' }), msg('next', 'u', 'user'), msg('a', 'next', 'assistant', { status: 'running' }),
    msg('s', 'failed', 'assistant', { summary: { throughId: 'failed', sourceIds: ['u', 'failed'] } })];
  const index = indexBranches(messages);
  assert.deepEqual(branchChoices(index, 'failed'), ['failed', 'next']);
  assert.equal(continuationParent(messages.slice(0, 2)), 'u');
  assert.equal(continuationParent([messages[2], messages[3]]), 'next');
  assert.equal(index.nodes.has('s'), false);
  assert.deepEqual(summariesOnBranch(messages, [messages[0], messages[1]]).map(({ id }) => id), ['s']);
  assert.deepEqual(summariesOnBranch(messages, [messages[0], messages[2], messages[3]]), []);
});

test('missing parents and cycles cannot produce a sendable partial path', () => {
  const index = indexBranches([msg('missing', 'gone'), msg('a', 'b'), msg('b', 'a')]);
  assert.throws(() => branchIds(index, 'missing'));
  assert.throws(() => recoverBranch(index, 'a', {}));
  assert.throws(() => recoverBranch(index, null, {}));
  assert.equal(index.browsable.size, 0);
});

test('long reversed parent chains and wide sibling groups are indexed without recursion or per-bubble copies', () => {
  const messages = Array.from({ length: 12000 }, (_, i) => msg(String(i), i ? String(i - 1) : null)).reverse();
  const index = indexBranches(messages);
  assert.equal(branchIds(index, '11999').length, 12000);
  const wide = indexBranches([msg('u', null, 'user'), ...Array.from({ length: 2000 }, (_, i) => msg(`a${i}`, 'u'))]);
  assert.equal(branchChoices(wide, 'a0'), branchChoices(wide, 'a1999'));
  assert.equal(wide.positions.get('a1999'), 1999);
});

test('streaming text, statuses and summary changes do not rebuild topology', () => {
  const indexer = branchIndexer(), messages = tree(), initial = indexer(messages);
  assert.equal(indexer(messages.map((message) => ({ ...message, status: 'running', parts: messageParts('streamed') }))), initial);
  assert.equal(indexer([...messages, msg('summary', 'b1', 'assistant', { summary: { throughId: 'b1', sourceIds: ['u', 'a1', 'u1', 'b1'] } })]), initial);
  assert.notEqual(indexer([...messages, msg('a3', 'u')]), initial);
});
