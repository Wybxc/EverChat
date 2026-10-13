import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSync } from '../shared/stream-sync';
import { commitAck, streamBatches } from '../shared/stream-batches';
import type { Commit, Message } from '../shared/types';

const message: Message = { id: 'answer', role: 'assistant', content: '', reasoning: '', status: 'running', createdAt: 1,
  runId: 'run', parentId: 'user', revisionOf: null, error: null, streamVersion: 'semantic-delta-v1', durableOffset: 0 };
const first = [...streamBatches('run', 'answer', 0, 0, '**正文🙂**', '先思考')][0];
const second = [...streamBatches('run', 'answer', 1, first.endOffset, '第二段', '**结论**')][0];
const commit: Commit = { type: 'commit', seq: 1, runId: 'run', messageId: 'answer', batches: [first] };

test('only confirmed output enters the durable snapshot; confirming a prefix preserves its live tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  assert.equal(sync.receive({ type: 'preview', batch: first }), false);
  sync.receive({ type: 'preview', batch: second });
  assert.equal(sync.durable.messages[0].content, ''); assert.equal(sync.durable.seq, 0);
  assert.equal(sync.view.messages[0].content, first.content + second.content);
  assert.equal(sync.view.messages[0].durableOffset, 0); assert.equal(sync.view.messages[0].liveOffset, second.endOffset);
  assert.equal(sync.receive(commitAck(commit)), true);
  assert.equal(sync.durable.messages[0].content, first.content); assert.equal(sync.durable.messages[0].liveOffset, undefined);
  assert.equal(sync.view.messages[0].content, first.content + second.content); assert.equal(sync.hasPreview, true);
  const finalCommit: Commit = { ...commit, seq: 2, batches: [second] };
  sync.receive(commitAck(finalCommit));
  assert.equal(sync.hasPreview, false); assert.deepEqual(sync.view, sync.durable);
  assert.equal(sync.durable.messages[0].reasoning, first.reasoning + second.reasoning);
  assert.equal(sync.receive(commitAck(finalCommit)), false);
});

test('reconnection discards ephemeral output and accepts durable replay before the current live tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive({ type: 'preview', batch: first }); sync.receive({ type: 'preview', batch: second });
  sync.resetPreview();
  assert.deepEqual(sync.view.messages, [message]);
  sync.receive(commit); sync.receive({ type: 'ready', seq: 1 });
  sync.receive({ type: 'preview', batch: first }); // Already saved, so no double append.
  sync.receive({ type: 'preview', batch: second }); sync.receive({ type: 'preview', batch: second });
  assert.equal(sync.view.messages[0].content, first.content + second.content);
  assert.equal(sync.durable.messages[0].content, first.content);
  sync.receive(commitAck({ ...commit, seq: 2, batches: [second] }));
  assert.equal(sync.view.messages[0].content, first.content + second.content);
});

test('missing previews, conflicting duplicates and gaps trigger recovery without advancing durability', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  assert.throws(() => sync.receive(commitAck(commit)), /Missing preview/);
  assert.equal(sync.durable.seq, 0);
  assert.throws(() => sync.receive({ type: 'preview', batch: second }), /offset gap/);
  sync.receive({ type: 'preview', batch: first });
  assert.throws(() => sync.receive({ type: 'preview', batch: { ...first, chunkSeq: 2 } }), /offset gap/);
  assert.throws(() => sync.receive({ type: 'preview', batch: { ...second, chunkSeq: 3 } }), /sequence gap/);
  assert.throws(() => sync.receive({ type: 'ready', seq: 2 }), /readiness gap/);
  assert.throws(() => sync.receive(commitAck({ ...commit, seq: 2 })), /sequence gap/);
  assert.equal(sync.durable.seq, 0);
  const altered = { ...first, content: first.content.replace('正文', '其他') };
  assert.throws(() => sync.receive({ type: 'preview', batch: altered }), /Conflicting preview/);
});

test('a failed terminal snapshot drops the uncommitted tail and retains the saved prefix', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive(commit); sync.receive({ type: 'preview', batch: second });
  const saved = sync.durable.messages[0];
  sync.receive({ type: 'change', seq: 2, messages: [{ ...saved, status: 'failed', error: '尾部未保存' }] });
  assert.equal(sync.hasPreview, false); assert.deepEqual(sync.view, sync.durable);
  assert.equal(sync.view.messages[0].content, first.content);
  assert.equal(sync.view.messages[0].liveOffset, undefined);
});

test('a group confirms the exact preview boundaries and cannot confirm a different task', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive({ type: 'preview', batch: first }); sync.receive({ type: 'preview', batch: second });
  const ack = commitAck({ ...commit, batches: [first, second] });
  assert.throws(() => sync.receive({ ...ack, runId: 'other' }), /Missing preview/);
  assert.throws(() => sync.receive({ ...ack, lastChunkSeq: 3 }), /Missing preview/);
  sync.receive(ack);
  assert.deepEqual(sync.view, sync.durable); assert.equal(sync.hasPreview, false);
  assert.equal(sync.durable.messages[0].durableOffset, second.endOffset);
});


test('unconfirmed previews are bounded even without persistence acknowledgements', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  const batches = [...streamBatches('run', 'answer', 0, 0, '\u0000'.repeat(24000), '')];
  sync.receive({ type: 'preview', batch: batches[0] }); sync.receive({ type: 'preview', batch: batches[1] });
  assert.throws(() => sync.receive({ type: 'preview', batch: batches[2] }), /buffer limit/);
  assert.equal(sync.durable.messages[0].content, ''); assert.equal(sync.durable.seq, 0);
  sync.resetPreview(); assert.equal(sync.view.messages[0].content, '');
});
