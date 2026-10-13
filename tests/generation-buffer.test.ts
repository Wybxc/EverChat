import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationBuffer } from '../worker/generation-buffer';
import { GenerationCancelled, ProviderError } from '../worker/generation-errors';
import { validateBatch, MAX_BATCH_BYTES, MAX_COMMIT_BYTES, payloadBytes, validateCommit } from '../shared/stream-batches';
import type { StreamBatch } from '../shared/types';

test('previews precede low-frequency persistence and keep continuous text and thought boundaries', () => {
  let now = 0;
  const batches: StreamBatch[] = [], previews: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => { batches.push(...group); return true; }, (batch) => previews.push(batch), true, () => now);
  buffer.add('content', '正文🙂'); buffer.add('reasoning', '**思考**');
  now = 99; buffer.tick(); assert.equal(batches.length, 0);
  now = 100; buffer.tick(); assert.equal(batches.length, 0); assert.equal(previews.length, 1);
  now = 1499; buffer.tick(); assert.equal(batches.length, 0);
  now = 1500; buffer.tick(); assert.equal(batches.length, 1);
  assert.equal(batches[0].content, '正文🙂'); assert.equal(batches[0].reasoning, '**思考**');
  buffer.add('content', '\n剩余内容'); buffer.flush(); buffer.flush();
  assert.equal(batches.length, 2); assert.equal(batches[1].startOffset, batches[0].endOffset);
  assert.equal(batches[1].chunkSeq, 2);
  assert.deepEqual(buffer.counts, { textDeltas: 2, reasoningDeltas: 1 });
});

test('large escaped and Unicode deltas remain bounded and exactly reconstruct the accepted output', () => {
  const batches: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => { assert.ok(payloadBytes(validateCommit({ runId: 'run', messageId: 'answer', batches: group })) <= MAX_COMMIT_BYTES); batches.push(...group); return true; });
  const content = '\u0000"\\🙂正文'.repeat(7000), reasoning = '思考🙂'.repeat(5000);
  buffer.add('content', content); buffer.add('reasoning', reasoning); buffer.flush();
  for (const [index, batch] of batches.entries()) {
    assert.ok(payloadBytes(validateBatch(batch)) <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
    assert.ok(!/[\uD800-\uDBFF]$/.test(batch.content) && !/[\uD800-\uDBFF]$/.test(batch.reasoning));
  }
  assert.equal(batches.map((batch) => batch.content).join(''), content);
  assert.equal(batches.map((batch) => batch.reasoning).join(''), reasoning);
  assert.equal(buffer.counts, undefined);
});

test('a failed write preserves the accepted prefix without retrying writes or accepting more output', () => {
  const accepted: StreamBatch[] = [];
  let attempts = 0;
  const failure = new Error('Storage unavailable');
  const buffer = new GenerationBuffer('run', 'answer', (group) => {
    if (++attempts === 2) throw failure;
    accepted.push(...group); return true;
  });
  assert.throws(() => buffer.add('content', '长'.repeat(40_000)), (error) => error === failure);
  assert.equal(accepted.length, 2); assert.equal(accepted.map((batch) => batch.content).join('').length, 16000);
  assert.throws(() => buffer.flush(), (error) => error === failure);
  assert.throws(() => buffer.add('reasoning', '不能继续'), (error) => error === failure);
  assert.equal(attempts, 2);
});

test('rejection by a terminal task stops buffering and cannot later produce another checkpoint', () => {
  let attempts = 0;
  const buffer = new GenerationBuffer('run', 'answer', () => { attempts++; return false; });
  buffer.add('content', '停止前收到的片段');
  assert.throws(() => buffer.flush(), GenerationCancelled);
  assert.throws(() => buffer.add('content', '停止后'), GenerationCancelled);
  assert.throws(() => buffer.flush(), GenerationCancelled);
  assert.equal(attempts, 1);
});

test('output limits preserve the bounded received tail and report an explicit provider error', () => {
  const batches: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => { assert.ok(payloadBytes(validateCommit({ runId: 'run', messageId: 'answer', batches: group })) <= MAX_COMMIT_BYTES); batches.push(...group); return true; });
  buffer.add('content', '文'.repeat(99_000));
  assert.throws(() => buffer.add('content', '文'.repeat(2000)), ProviderError);
  buffer.flush();
  assert.equal(batches.map((batch) => batch.content).join('').length, 100_000);
  assert.throws(() => buffer.add('reasoning', '想'.repeat(100_001)), ProviderError);
  buffer.flush();
  assert.equal(batches.map((batch) => batch.reasoning).join('').length, 100_000);
});

test('the output limit never cuts a Unicode surrogate pair into a malformed final character', () => {
  const batches: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => { assert.ok(payloadBytes(validateCommit({ runId: 'run', messageId: 'answer', batches: group })) <= MAX_COMMIT_BYTES); batches.push(...group); return true; });
  buffer.add('content', '文'.repeat(99_999));
  assert.throws(() => buffer.add('content', '🙂尾部'), ProviderError);
  buffer.flush();
  assert.equal(batches.map((batch) => batch.content).join(''), '文'.repeat(99_999));
});


test('microbatches share one atomic commit without changing preview offsets', () => {
  let now = 0;
  const groups: StreamBatch[][] = [], previews: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => { groups.push(group); return true; }, (batch) => previews.push(batch), false, () => now);
  for (let i = 0; i < 14; i++) { buffer.add('content', `正文${i}🙂`); now += 100; buffer.tick(); }
  assert.equal(previews.length, 14); assert.equal(groups.length, 0);
  now = 1500; buffer.tick();
  assert.equal(groups.length, 1); assert.deepEqual(groups[0], previews);
  assert.equal(buffer.previewTail.length, 0);
  buffer.add('reasoning', '尾部'); buffer.flush();
  assert.equal(groups.length, 2); assert.equal(groups[1][0].startOffset, groups[0].at(-1)!.endOffset);
});
