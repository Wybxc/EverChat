import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotWriter } from '../src/features/chat/snapshot-writer';
import type { Snapshot } from '../shared/streaming/protocol';

test('continuous updates write the latest durable snapshot at a bounded frequency without starving the timer', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: Snapshot[] = [];
  const writer = new SnapshotWriter((snapshot) => writes.push(snapshot));
  for (let seq = 1; seq <= 19; seq++) { writer.schedule({ messages: [], seq }); context.mock.timers.tick(100); }
  assert.equal(writes.length, 0);
  writer.schedule({ messages: [], seq: 20 }); context.mock.timers.tick(100);
  assert.deepEqual(writes.map((snapshot) => snapshot.seq), [20]);
  writer.schedule({ messages: [], seq: 21 }); context.mock.timers.tick(2000);
  assert.deepEqual(writes.map((snapshot) => snapshot.seq), [20, 21]);
});

test('completion, navigation and hiding the page flush immediately and cancel delayed duplicate writes', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: Snapshot[] = [];
  const writer = new SnapshotWriter((snapshot) => writes.push(snapshot));
  writer.schedule({ messages: [], seq: 1 }); writer.schedule({ messages: [], seq: 2 }, true);
  assert.equal(writes[0].seq, 2);
  writer.schedule({ messages: [], seq: 3 }); writer.flush(); writer.flush();
  context.mock.timers.tick(5000);
  assert.deepEqual(writes.map((snapshot) => snapshot.seq), [2, 3]);
});
