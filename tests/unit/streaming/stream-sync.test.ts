import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageParts, messageText } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { Message } from '../../../shared/conversation/types';
import { commitAck, streamBatches } from '../../../shared/streaming/batches';
import type { Commit } from '../../../shared/streaming/protocol';
import { ProviderStream, encodeBytes } from '../../../shared/streaming/provider-stream';
import { StreamSync } from '../../../shared/streaming/sync';
import { reasoningBlocks } from '../../../shared/web-tools/reasoning-flow';

const message: Message = {
  id: 'answer',
  role: 'assistant',
  parts: [],
  status: 'running',
  createdAt: 1,
  runId: 'run',
  parentId: 'user',
  revisionOf: null,
  error: null,
  streamVersion: 'events-v1',
  durableOffset: 0,
  streamState: new ProviderStream('openai-chat', true).checkpoint(),
};
const wire = (content: string, reasoning: string) =>
  new TextEncoder().encode(
    JSON.stringify({ type: 'text', text: content }) +
      '\n' +
      JSON.stringify({ type: 'reasoning', text: reasoning }) +
      '\n',
  );
const first = [...streamBatches('run', 'answer', 0, 0, wire('**正文🙂**', '先思考'))][0];
const second = [
  ...streamBatches('run', 'answer', 1, first.endOffset, wire('第二段', '**结论**')),
][0];
const commit: Commit = {
  type: 'commit',
  seq: 1,
  runId: 'run',
  messageId: 'answer',
  batches: [first],
};

test('a tool boundary atomically fixes a preview prefix and survives a new run, stale previews and reconnect', () => {
  const sync = new StreamSync({ messages: [message], seq: 0, epoch: 'epoch' });
  sync.receive({ type: 'preview', batch: first });
  const ended: Message = {
    ...sync.view.messages[0],
    liveOffset: undefined,
    durableOffset: first.endOffset,
    streamVersion: null,
    tools: {
      status: 'active',
      round: 0,
      calls: [
        {
          round: 0,
          call: { id: 'search', name: 'web_search', input: { query: '资料' } },
          state: 'running',
        },
      ],
      reasoningBreaks: [{ round: 0, reasoningEnd: 3 }],
    },
  };
  sync.receive({ type: 'change', seq: 1, messages: [ended] });
  assert.equal(sync.hasPreview, false);
  const continued = {
    ...ended,
    runId: 'next',
    durableOffset: 0,
    streamVersion: message.streamVersion,
    streamState: new ProviderStream('openai-chat', true).checkpoint(),
  };
  sync.receive({ type: 'change', seq: 2, messages: [continued] });
  assert.throws(() => sync.receive({ type: 'preview', batch: first }), /identity mismatch/);
  const next = [...streamBatches('next', 'answer', 0, 0, wire('回答', '再思考🙂'))][0];
  sync.receive({ type: 'preview', batch: next });
  assert.deepEqual(
    reasoningBlocks(
      messageText(sync.view.messages[0], 'reasoning'),
      sync.view.messages[0].tools,
    ).map((block) => (block.type === 'reasoning' ? block.text : '搜索')),
    ['先思考', '搜索', '再思考🙂'],
  );
  sync.receive({ type: 'commit', seq: 3, runId: 'next', messageId: 'answer', batches: [next] });
  const saved = sync.durable;
  const reconnect = new StreamSync();
  reconnect.receive({ type: 'snapshot', snapshot: saved });
  assert.deepEqual(reconnect.view, saved);
  const bad = { ...continued, parts: [] };
  assert.throws(
    () =>
      sync.receive({ type: 'state', after: 3, snapshot: { ...saved, seq: 4, messages: [bad] } }),
    /position mismatch/,
  );
  assert.equal(sync.durable, saved);
  assert.deepEqual(new StreamSync({ ...saved, messages: [bad] }).durable, { messages: [], seq: 0 });
});

test('settings changes survive live previews, confirmation and message-only updates', () => {
  const settings = { ...DEFAULT_CONVERSATION_SETTINGS, systemPrompt: 'conversation prompt' };
  const sync = new StreamSync({
    messages: [message],
    seq: 0,
    settings: DEFAULT_CONVERSATION_SETTINGS,
  });
  sync.receive({ type: 'preview', batch: first });
  sync.receive({ type: 'change', seq: 1, messages: [], settings });
  assert.deepEqual(sync.view.settings, settings);
  assert.equal(sync.hasPreview, true);
  sync.receive(commitAck({ ...commit, seq: 2 }));
  sync.receive({
    type: 'change',
    seq: 3,
    messages: [{ ...sync.durable.messages[0], status: 'completed' }],
  });
  assert.deepEqual(sync.durable.settings, settings);
  assert.deepEqual(sync.view.settings, settings);
});

test('only confirmed output enters the durable snapshot; confirming a prefix preserves its live tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  assert.equal(sync.receive({ type: 'preview', batch: first }), false);
  sync.receive({ type: 'preview', batch: second });
  assert.equal(messageText(sync.durable.messages[0]), '');
  assert.equal(sync.durable.seq, 0);
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**第二段');
  assert.deepEqual(sync.view.messages[0].parts, messageParts('**正文🙂**第二段', '先思考**结论**'));
  assert.equal('content' in sync.view.messages[0] || 'reasoning' in sync.view.messages[0], false);
  assert.equal(sync.view.messages[0].durableOffset, 0);
  assert.equal(sync.view.messages[0].liveOffset, second.endOffset);
  assert.equal(sync.receive(commitAck(commit)), true);
  assert.equal(messageText(sync.durable.messages[0]), '**正文🙂**');
  assert.equal(sync.durable.messages[0].liveOffset, undefined);
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**第二段');
  assert.equal(sync.hasPreview, true);
  const finalCommit: Commit = { ...commit, seq: 2, batches: [second] };
  sync.receive(commitAck(finalCommit));
  assert.equal(sync.hasPreview, false);
  assert.deepEqual(sync.view, sync.durable);
  assert.equal(messageText(sync.durable.messages[0], 'reasoning'), '先思考**结论**');
  assert.equal(sync.receive(commitAck(finalCommit)), false);
});

test('reconnection discards ephemeral output and accepts durable replay before the current live tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive({ type: 'preview', batch: first });
  sync.receive({ type: 'preview', batch: second });
  sync.resetPreview();
  assert.deepEqual(sync.view.messages, [message]);
  sync.receive(commit);
  sync.receive({ type: 'ready', seq: 1 });
  sync.receive({ type: 'preview', batch: first }); // Already saved, so no double append.
  sync.receive({ type: 'preview', batch: second });
  sync.receive({ type: 'preview', batch: second });
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**第二段');
  assert.equal(messageText(sync.durable.messages[0]), '**正文🙂**');
  sync.receive(commitAck({ ...commit, seq: 2, batches: [second] }));
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**第二段');
});

test('missing previews, conflicting duplicates and gaps trigger recovery without advancing durability', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  assert.throws(() => sync.receive(commitAck(commit)), /Missing preview/);
  assert.equal(sync.durable.seq, 0);
  assert.throws(() => sync.receive({ type: 'preview', batch: second }), /offset gap/);
  sync.receive({ type: 'preview', batch: first });
  assert.throws(
    () => sync.receive({ type: 'preview', batch: { ...first, chunkSeq: 2 } }),
    /offset gap/,
  );
  assert.throws(
    () => sync.receive({ type: 'preview', batch: { ...second, chunkSeq: 3 } }),
    /sequence gap/,
  );
  assert.throws(() => sync.receive({ type: 'ready', seq: 2 }), /readiness gap/);
  assert.throws(() => sync.receive(commitAck({ ...commit, seq: 2 })), /sequence gap/);
  assert.equal(sync.durable.seq, 0);
  const altered = { ...first, data: encodeBytes(wire('**其他🙂**', '先思考')) };
  assert.throws(() => sync.receive({ type: 'preview', batch: altered }), /Conflicting preview/);
});

test('a failed terminal snapshot drops the uncommitted tail and retains the saved prefix', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive(commit);
  sync.receive({ type: 'preview', batch: second });
  const saved = sync.durable.messages[0];
  sync.receive({
    type: 'change',
    seq: 2,
    messages: [{ ...saved, status: 'failed', error: '尾部未保存' }],
  });
  assert.equal(sync.hasPreview, false);
  assert.deepEqual(sync.view, sync.durable);
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**');
  assert.equal(sync.view.messages[0].liveOffset, undefined);
});

test('a group confirms the exact preview boundaries and cannot confirm a different task', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  sync.receive({ type: 'preview', batch: first });
  sync.receive({ type: 'preview', batch: second });
  const ack = commitAck({ ...commit, batches: [first, second] });
  assert.throws(() => sync.receive({ ...ack, runId: 'other' }), /Missing preview/);
  assert.throws(() => sync.receive({ ...ack, lastChunkSeq: 3 }), /Missing preview/);
  sync.receive(ack);
  assert.deepEqual(sync.view, sync.durable);
  assert.equal(sync.hasPreview, false);
  assert.equal(sync.durable.messages[0].durableOffset, second.endOffset);
});

test('unconfirmed previews are bounded even without persistence acknowledgements', () => {
  const sync = new StreamSync({ messages: [message], seq: 0 });
  const batches = [
    ...streamBatches('run', 'answer', 0, 0, new TextEncoder().encode(':'.repeat(140000))),
  ];
  for (const batch of batches.slice(0, 16)) sync.receive({ type: 'preview', batch });
  assert.throws(() => sync.receive({ type: 'preview', batch: batches[16] }), /buffer limit/);
  assert.equal(messageText(sync.durable.messages[0]), '');
  assert.equal(sync.durable.seq, 0);
  sync.resetPreview();
  assert.equal(messageText(sync.view.messages[0]), '');
});

test('latest-state reconciliation skips lost notifications and preserves only the unconfirmed preview tail', () => {
  const sync = new StreamSync({ messages: [message], seq: 0, epoch: 'epoch' });
  sync.receive({ type: 'preview', batch: first });
  sync.receive({ type: 'preview', batch: second });
  const confirmed = new StreamSync({ messages: [message], seq: 0 });
  confirmed.receive(commit);
  sync.receive({
    type: 'state',
    after: 0,
    snapshot: { ...confirmed.durable, epoch: 'epoch', seq: 100 },
  });
  assert.equal(sync.durable.seq, 100);
  assert.equal(messageText(sync.durable.messages[0]), '**正文🙂**');
  assert.equal(messageText(sync.view.messages[0]), '**正文🙂**第二段');
  assert.equal(sync.hasPreview, true);
  const unchanged = sync.durable;
  assert.throws(
    () => sync.receive({ type: 'state', after: 100, snapshot: { ...unchanged, epoch: 'other' } }),
    /baseline mismatch/,
  );
  assert.equal(sync.durable, unchanged);
  assert.throws(() => sync.receive({ type: 'resync' }), /Fresh state/);
  assert.equal(
    sync.receive({ type: 'state', after: 0, snapshot: { ...unchanged, seq: 99 } }),
    false,
  );
  sync.receive({
    type: 'state',
    after: 100,
    snapshot: {
      ...unchanged,
      seq: 101,
      messages: [{ ...message, parts: [], status: 'completed', deletedAt: 2 }],
    },
  });
  assert.equal(sync.hasPreview, false);
  assert.deepEqual(sync.view.messages[0].parts, []);
});
