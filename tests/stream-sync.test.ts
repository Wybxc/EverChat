import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSync } from '../shared/stream-sync';
import { commitAck, streamBatches } from '../shared/stream-batches';
import { ProviderStream, encodeBytes } from '../shared/provider-stream';
import type { Commit, Message } from '../shared/types';
import { DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';

const message: Message = { id: 'answer', role: 'assistant', content: '', reasoning: '', status: 'running', createdAt: 1,
  runId: 'run', parentId: 'user', revisionOf: null, error: null, streamVersion: 'raw-sse-v1', durableOffset: 0, streamState: new ProviderStream('openai-chat', true).checkpoint() };
const wire = (content: string, reasoning: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning } }] })}\n\n`);
const first = [...streamBatches('run', 'answer', 0, 0, wire('**正文🙂**', '先思考'))][0];
const second = [...streamBatches('run', 'answer', 1, first.endOffset, wire('第二段', '**结论**'))][0];
const commit: Commit = { type: 'commit', seq: 1, runId: 'run', messageId: 'answer', batches: [first] };

test('settings changes survive live previews, confirmation and message-only updates', () => {
  const settings = { ...DEFAULT_CONVERSATION_SETTINGS, systemPrompt: 'conversation prompt' };
  const sync = new StreamSync({ messages: [message], seq: 0, settings: DEFAULT_CONVERSATION_SETTINGS });
  sync.receive({ type: 'preview', batch: first });
  sync.receive({ type: 'change', seq: 1, messages: [], settings });
  assert.deepEqual(sync.view.settings, settings); assert.equal(sync.hasPreview, true);
  sync.receive(commitAck({ ...commit, seq: 2 }));
  sync.receive({ type: 'change', seq: 3, messages: [{ ...sync.durable.messages[0], status: 'completed' }] });
  assert.deepEqual(sync.durable.settings, settings); assert.deepEqual(sync.view.settings, settings);
});

test('only confirmed output enters the durable snapshot; confirming a prefix preserves its live tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  assert.equal(sync.receive({ type: 'preview', batch: first }), false);
  sync.receive({ type: 'preview', batch: second });
  assert.equal(sync.durable.messages[0].content, ''); assert.equal(sync.durable.seq, 0);
  assert.equal(sync.view.messages[0].content, '**正文🙂**第二段');
  assert.equal(sync.view.messages[0].durableOffset, 0); assert.equal(sync.view.messages[0].liveOffset, second.endOffset);
  assert.equal(sync.receive(commitAck(commit)), true);
  assert.equal(sync.durable.messages[0].content, '**正文🙂**'); assert.equal(sync.durable.messages[0].liveOffset, undefined);
  assert.equal(sync.view.messages[0].content, '**正文🙂**第二段'); assert.equal(sync.hasPreview, true);
  const finalCommit: Commit = { ...commit, seq: 2, batches: [second] };
  sync.receive(commitAck(finalCommit));
  assert.equal(sync.hasPreview, false); assert.deepEqual(sync.view, sync.durable);
  assert.equal(sync.durable.messages[0].reasoning, '先思考**结论**');
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
  assert.equal(sync.view.messages[0].content, '**正文🙂**第二段');
  assert.equal(sync.durable.messages[0].content, '**正文🙂**');
  sync.receive(commitAck({ ...commit, seq: 2, batches: [second] }));
  assert.equal(sync.view.messages[0].content, '**正文🙂**第二段');
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
  const altered = { ...first, data: encodeBytes(wire('**其他🙂**', '先思考')) };
  assert.throws(() => sync.receive({ type: 'preview', batch: altered }), /Conflicting preview/);
});

test('a failed terminal snapshot drops the uncommitted tail and retains the saved prefix', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive(commit); sync.receive({ type: 'preview', batch: second });
  const saved = sync.durable.messages[0];
  sync.receive({ type: 'change', seq: 2, messages: [{ ...saved, status: 'failed', error: '尾部未保存' }] });
  assert.equal(sync.hasPreview, false); assert.deepEqual(sync.view, sync.durable);
  assert.equal(sync.view.messages[0].content, '**正文🙂**');
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
  const batches = [...streamBatches('run', 'answer', 0, 0, new TextEncoder().encode(':'.repeat(140000)))];
  for (const batch of batches.slice(0, 16)) sync.receive({ type: 'preview', batch });
  assert.throws(() => sync.receive({ type: 'preview', batch: batches[16] }), /buffer limit/);
  assert.equal(sync.durable.messages[0].content, ''); assert.equal(sync.durable.seq, 0);
  sync.resetPreview(); assert.equal(sync.view.messages[0].content, '');
});
