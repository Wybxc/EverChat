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
import {
  consumeModelStream,
  type ActiveGeneration,
} from '../../../worker/generation/consume-stream';
const encode = (value: string) => new TextEncoder().encode(value);
const collected = (batches: StreamBatch[]) =>
  Buffer.concat(batches.map((batch) => validateBatch(batch)));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

test('raw previews precede low-frequency persistence and preserve original byte offsets', async () => {
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
  await buffer.add(encode('正文🙂'));
  await buffer.add(encode('**思考**'));
  now = 99;
  await buffer.tick();
  assert.equal(previews.length, 0);
  now = 100;
  await buffer.tick();
  assert.equal(batches.length, 0);
  assert.equal(previews.length, 1);
  now = 1499;
  await buffer.tick();
  assert.equal(batches.length, 0);
  now = 1500;
  await buffer.tick();
  assert.equal(batches.length, 1);
  assert.equal(collected(batches).toString(), '正文🙂**思考**');
  await buffer.add(encode('剩余内容'));
  await buffer.flush();
  await buffer.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].startOffset, batches[0].endOffset);
  assert.equal(batches[1].chunkSeq, 2);
});

test('arbitrary bytes and partial Unicode frames are bounded and exactly reconstruct the supplier stream', async () => {
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
  await buffer.add(bytes);
  await buffer.flush();
  for (const [index, batch] of batches.entries()) {
    assert.ok(validateBatch(batch).length <= MAX_BATCH_BYTES);
    assert.equal(batch.chunkSeq, index + 1);
    assert.equal(batch.startOffset, index === 0 ? 0 : batches[index - 1].endOffset);
  }
  assert.deepEqual(collected(batches), Buffer.from(bytes));
});

test('a failed write preserves the committed prefix without retrying writes or accepting more bytes', async () => {
  const accepted: StreamBatch[] = [];
  let attempts = 0;
  const failure = new Error('Storage unavailable');
  const buffer = new GenerationBuffer('run', 'answer', (group) => {
    if (++attempts === 2) throw failure;
    accepted.push(...group);
    return true;
  });
  await assert.rejects(
    () => buffer.add(new Uint8Array(100_000)),
    (error) => error === failure,
  );
  assert.equal(accepted.length, 4);
  assert.equal(collected(accepted).length, 32 * 1024);
  await assert.rejects(
    () => buffer.flush(),
    (error) => error === failure,
  );
  await assert.rejects(
    () => buffer.add(encode('不能继续')),
    (error) => error === failure,
  );
  assert.equal(attempts, 2);
});

test('rejection by a terminal task stops buffering and cannot produce another checkpoint', async () => {
  let attempts = 0;
  const buffer = new GenerationBuffer('run', 'answer', () => {
    attempts++;
    return false;
  });
  await buffer.add(encode('停止前收到的片段'));
  await assert.rejects(() => buffer.flush(), GenerationCancelled);
  await assert.rejects(() => buffer.add(encode('停止后')), GenerationCancelled);
  await assert.rejects(() => buffer.flush(), GenerationCancelled);
  assert.equal(attempts, 1);
});

test('wire overhead beyond 4 MiB does not interrupt bounded commits or change offsets', async () => {
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
  for (let i = 0; i < 160; i++) await buffer.add(bytes);
  await buffer.flush();
  assert.equal(received, 10 * 1024 * 1024);
  assert.ok(chunks > 1);
  assert.equal(buffer.previewTail.length, 0);
});

test('microbatches share one atomic commit without changing preview offsets', async () => {
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
    await buffer.add(encode(`正文${i}🙂`));
    now += 100;
    await buffer.tick();
  }
  assert.equal(previews.length, 14);
  assert.equal(groups.length, 0);
  now = 1500;
  await buffer.tick();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], previews);
  assert.equal(buffer.previewTail.length, 0);
  await buffer.add(encode('尾部'));
  await buffer.flush();
  assert.equal(groups.length, 2);
  assert.equal(groups[1][0].startOffset, groups[0].at(-1)!.endOffset);
});

test('slow asynchronous persistence bounds the tail and coalesces timer work', async () => {
  const entered = deferred(),
    release = deferred();
  const writes: StreamBatch[][] = [];
  let concurrent = 0;
  const buffer = new GenerationBuffer('run', 'answer', async (group) => {
    assert.equal(++concurrent, 1);
    writes.push(group);
    entered.resolve();
    await release.promise;
    concurrent--;
    return true;
  });
  const adding = buffer.add(new Uint8Array(64 * 1024));
  await entered.promise;
  assert.equal(buffer.busy, true);
  assert.equal(writes.length, 1);
  assert.equal(buffer.previewTail.at(-1)?.endOffset, 32 * 1024);
  const timer = buffer.tick();
  for (let i = 0; i < 100; i++) assert.equal(buffer.tick(), timer);
  const flushing = buffer.flush();
  release.resolve();
  await Promise.all([adding, timer, flushing]);
  assert.equal(writes.length, 2);
  assert.equal(collected(writes.flat()).byteLength, 64 * 1024);
  assert.equal(buffer.previewTail.length, 0);
  assert.equal(buffer.busy, false);
});

test('an asynchronous write rejection settles waiting operations without another write', async () => {
  const entered = deferred(),
    release = deferred<boolean>();
  const failure = new Error('Async persistence failed');
  let attempts = 0;
  const buffer = new GenerationBuffer('run', 'answer', async () => {
    attempts++;
    entered.resolve();
    return release.promise;
  });
  const adding = assert.rejects(buffer.add(new Uint8Array(64 * 1024)), (e) => e === failure);
  await entered.promise;
  const flushing = assert.rejects(buffer.flush(), (e) => e === failure);
  const timer = assert.rejects(buffer.tick(), (e) => e === failure);
  release.reject(failure);
  await Promise.all([adding, flushing, timer]);
  assert.equal(attempts, 1);
  await assert.rejects(buffer.add(encode('不能继续')), (e) => e === failure);
});

test('model consumption awaits the chunk sink and cancellation does not consume another chunk', async () => {
  const entered = deferred(),
    release = deferred();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('first'));
      controller.enqueue(encode('second'));
      controller.close();
    },
  });
  const active: ActiveGeneration = {
    runId: 'run',
    abort: new AbortController(),
    cancelled: false,
    buffer: new GenerationBuffer('run', 'answer', () => true),
  };
  const received: string[] = [];
  const consuming = consumeModelStream(body, active, async (bytes) => {
    received.push(new TextDecoder().decode(bytes));
    entered.resolve();
    await release.promise;
  });
  const cancelled = assert.rejects(consuming, GenerationCancelled);
  await entered.promise;
  assert.deepEqual(received, ['first']);
  active.cancelled = true;
  release.resolve();
  await cancelled;
  assert.deepEqual(received, ['first']);
  assert.equal(body.locked, false);
});
