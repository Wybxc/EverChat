import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GenerationMeter, measuredQuery } from '../../../worker/generation/metrics';

test('generation measurements count UTF-8 payloads, fanout and raw checkpoint bytes', () => {
  let time = 100;
  const meter = new GenerationMeter('run', () => time);
  meter.rawCheckpoint(20);
  meter.rawCheckpoint(40);
  meter.streamCounts({ textDeltas: 3, reasoningDeltas: 4 });
  meter.event('你好');
  meter.broadcast('你好', 2);
  meter.broadcast('ignored', 0);
  meter.sql(5, 3);
  meter.sql(2, 1);
  time = 350;
  assert.deepEqual(meter.report('completed', 4096, 4, 6), {
    runId: 'run',
    coverage: 'claim-to-terminal',
    status: 'completed',
    elapsedMs: 250,
    textDeltas: 3,
    reasoningDeltas: 4,
    checkpoints: 2,
    checkpointBytes: 60,
    sqlStatements: 2,
    sqlRowsRead: 7,
    sqlRowsWritten: 4,
    eventPayloadBytes: 6,
    broadcastFrames: 2,
    broadcastBytes: 12,
    databaseBytes: 4096,
    contentCharacters: 4,
    reasoningCharacters: 6,
  });
});

test('SQL measurement reads counters after draining the cursor and preserves result access', () => {
  const meter = new GenerationMeter('run', () => 0);
  let consumed = false;
  const row = { id: 1 };
  const cursor = {
    toArray: () => {
      consumed = true;
      return [row];
    },
    get rowsRead() {
      return consumed ? 7 : 0;
    },
    get rowsWritten() {
      return consumed ? 2 : 0;
    },
  };
  const sql = { exec: () => cursor } as unknown as SqlStorage;
  const result = measuredQuery(sql, meter, 'SELECT id FROM example');
  assert.deepEqual(result.one(), row);
  assert.deepEqual(result.toArray(), [], 'one() consumes the row like a native cursor');
  assert.throws(() => result.one(), /exactly one/);
  assert.equal(meter.report('running', 0, 0, 0).sqlRowsRead, 7);
  assert.equal(meter.report('running', 0, 0, 0).sqlRowsWritten, 2);
  const plain = measuredQuery(sql, undefined, 'SELECT id FROM example');
  assert.equal(plain, cursor, 'disabled metrics preserve the native cursor');
  const iterable = measuredQuery(sql, meter, 'SELECT id FROM example');
  assert.deepEqual([...iterable], [row]);
  assert.deepEqual(iterable.toArray(), []);
});
