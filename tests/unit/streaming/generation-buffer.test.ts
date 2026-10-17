import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_BATCH_BYTES,
  MAX_COMMIT_BYTES,
  payloadBytes,
  validateBatch,
  validateCommit,
} from '../../../shared/streaming/batches';
import type { StreamBatch } from '../../../shared/streaming/protocol';
import { GenerationBuffer } from '../../../worker/generation/buffer';
import { GenerationCancelled } from '../../../worker/generation/errors';
const encode = (value: string) => new TextEncoder().encode(value);
const collected = (batches: StreamBatch[]) =>
  Buffer.concat(batches.map((batch) => validateBatch(batch)));

test('raw previews precede low-frequency persistence and preserve original byte offsets', () => {
  let now = 0;
  const batches: StreamBatch[] = [],
    previews: StreamBatch[] = [];
  const buffer = new GenerationBuffer(
    'run',
    'answer',
    (group) => {
      batches.push(...group);
      return true;
    },
    (batch) => previews.push(batch),
    () => now,
  );
  buffer.add(encode('正文🙂'));
  buffer.add(encode('**思考**'));
  now = 99;
  buffer.tick();
  assert.equal(previews.length, 0);
  now = 100;
  buffer.tick();
  assert.equal(batches.length, 0);
  assert.equal(previews.length, 1);
  now = 1499;
  buffer.tick();
  assert.equal(batches.length, 0);
  now = 1500;
  buffer.tick();
  assert.equal(batches.length, 1);
  assert.equal(collected(batches).toString(), '正文🙂**思考**');
  buffer.add(encode('剩余内容'));
  buffer.flush();
  buffer.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].startOffset, batches[0].endOffset);
  assert.equal(batches[1].chunkSeq, 2);
});

test('arbitrary bytes and partial Unicode frames are bounded and exactly reconstruct the supplier stream', () => {
  const batches: StreamBatch[] = [];
  const buffer = new GenerationBuffer('run', 'answer', (group) => {
    assert.ok(
      payloadBytes(validateCommit({ runId: 'run', messageId: 'answer', batches: group })) <=
        MAX_COMMIT_BYTES,
    );
    batches.push(...group);
    return true;
  });
  const bytes = encode('\u0000"\\🙂正文'.repeat(7000));
  buffer.add(bytes);
  buffer.flush();
  for (const [index, batch] of batches.entries()) {
    assert.ok(validateBatch(batch).length <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
  }
  assert.deepEqual(collected(batches), Buffer.from(bytes));
});

test('a failed write preserves the committed prefix without retrying writes or accepting more bytes', () => {
  const accepted: StreamBatch[] = [];
  let attempts = 0;
  const failure = new Error('Storage unavailable');
  const buffer = new GenerationBuffer('run', 'answer', (group) => {
    if (++attempts === 2) throw failure;
    accepted.push(...group);
    return true;
  });
  assert.throws(
    () => buffer.add(new Uint8Array(100_000)),
    (error) => error === failure,
  );
  assert.equal(accepted.length, 4);
  assert.equal(collected(accepted).length, 32 * 1024);
  assert.throws(
    () => buffer.flush(),
    (error) => error === failure,
  );
  assert.throws(
    () => buffer.add(encode('不能继续')),
    (error) => error === failure,
  );
  assert.equal(attempts, 2);
});

test('rejection by a terminal task stops buffering and cannot produce another checkpoint', () => {
  let attempts = 0;
  const buffer = new GenerationBuffer('run', 'answer', () => {
    attempts++;
    return false;
  });
  buffer.add(encode('停止前收到的片段'));
  assert.throws(() => buffer.flush(), GenerationCancelled);
  assert.throws(() => buffer.add(encode('停止后')), GenerationCancelled);
  assert.throws(() => buffer.flush(), GenerationCancelled);
  assert.equal(attempts, 1);
});

test('wire overhead beyond 4 MiB does not interrupt bounded commits or change offsets', () => {
  let received = 0,
    chunks = 0;
  const buffer = new GenerationBuffer('run', 'answer', (batches) => {
    for (const batch of batches) {
      assert.equal(batch.startOffset, received);
      received += validateBatch(batch).byteLength;
      chunks++;
    }
    assert.ok(
      payloadBytes(validateCommit({ runId: 'run', messageId: 'answer', batches })) <=
        MAX_COMMIT_BYTES,
    );
    return true;
  });
  const bytes = new Uint8Array(64 * 1024).fill(97);
  for (let i = 0; i < 160; i++) buffer.add(bytes);
  buffer.flush();
  assert.equal(received, 10 * 1024 * 1024);
  assert.ok(chunks > 1);
  assert.equal(buffer.previewTail.length, 0);
});

test('microbatches share one atomic commit without changing preview offsets', () => {
  let now = 0;
  const groups: StreamBatch[][] = [],
    previews: StreamBatch[] = [];
  const buffer = new GenerationBuffer(
    'run',
    'answer',
    (group) => {
      groups.push(group);
      return true;
    },
    (batch) => previews.push(batch),
    () => now,
  );
  for (let i = 0; i < 14; i++) {
    buffer.add(encode(`正文${i}🙂`));
    now += 100;
    buffer.tick();
  }
  assert.equal(previews.length, 14);
  assert.equal(groups.length, 0);
  now = 1500;
  buffer.tick();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], previews);
  assert.equal(buffer.previewTail.length, 0);
  buffer.add(encode('尾部'));
  buffer.flush();
  assert.equal(groups.length, 2);
  assert.equal(groups[1][0].startOffset, groups[0].at(-1)!.endOffset);
});
