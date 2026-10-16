import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureResourceMeter } from '../../support/runtime/resource-meter';

test('fixture SQL counters observe lazy consumption and preserve native cursor semantics', () => {
  let at = 0;
  const rows = [{ value: 1 }, { value: 2 }];
  const cursor = { get rowsRead() { return at; }, rowsWritten: 3,
    toArray() { const rest = rows.slice(at); at = rows.length; return rest; },
    one() { if (rows.length - at !== 1) throw new Error('Expected one'); return rows[at++]; },
    *[Symbol.iterator]() { while (at < rows.length) yield rows[at++]; } };
  const state = { storage: { sql: { exec() { at = 0; return cursor; } } } } as unknown as DurableObjectState;
  const meter = new FixtureResourceMeter(), wrapped = meter.wrapState(state);
  assert.equal(wrapped.storage.sql.exec('SELECT value FROM messages'), cursor, 'unarmed instrumentation returns the original cursor');
  meter.begin(crypto.randomUUID());
  const measured = wrapped.storage.sql.exec('SELECT value FROM messages');
  assert.equal(at, 0, 'SQL observation does not force reads early');
  assert.equal(meter.read()!.sql.other.rowsWritten, 3);
  const iterator = measured[Symbol.iterator]();
  assert.deepEqual(iterator.next().value, rows[0]);
  assert.equal(meter.read()!.sql.other.rowsRead, 1);
  iterator.return?.();
  assert.deepEqual(measured.one(), rows[1]);
  assert.deepEqual(measured.toArray(), []);
  assert.deepEqual(meter.read()!.sql.other, { statements: 1, rowsRead: 2, rowsWritten: 3 });
  wrapped.storage.sql.exec('SELECT payload FROM generation_measurements').toArray();
  wrapped.storage.sql.exec('INSERT INTO fixture_secret VALUES (?)', 'must-never-appear').toArray();
  assert.equal(meter.read()!.sql.other.statements, 1, 'fixture and old diagnostic SQL are excluded');
  assert.equal(JSON.stringify(meter.read()).includes('must-never-appear'), false);
});

test('fixture measures both journals, fanout, alarm calls and upstream bytes without retaining payloads', () => {
  const cursor = { rowsRead: 0, rowsWritten: 1 };
  let sends = 0, alarms = 0;
  const state = { storage: { sql: { exec() { return cursor; } }, setAlarm() { alarms++; } },
    getWebSockets() { return [{ send() { sends++; } }]; } } as unknown as DurableObjectState;
  const meter = new FixtureResourceMeter(), wrapped = meter.wrapState(state), windowId = crypto.randomUUID();
  const privatePayload = 'never-retain-this-sensitive-payload';
  meter.begin(windowId);
  wrapped.storage.sql.exec('INSERT INTO stream_commits VALUES (?, ?, ?, ?, ?, ?)', 'run', 1, 2, 0, 40, '你好');
  wrapped.storage.sql.exec('INSERT INTO tool_stream_commits VALUES (?, ?, ?, ?, ?, ?)', 'run', 1, 2, 0, 90, privatePayload);
  wrapped.storage.sql.exec('INSERT INTO events (payload) VALUES (?)', '你好');
  wrapped.storage.sql.exec('SELECT id FROM web_tool_requests').toArray?.();
  wrapped.getWebSockets()[0].send('你好'); wrapped.storage.setAlarm(123);
  meter.upstream('modelRequests'); meter.upstream('modelBytes', 90);
  const report = meter.read()!;
  assert.deepEqual(report.streams, { public: { commits: 1, wireBytes: 40, payloadBytes: 6 }, private: { commits: 1, wireBytes: 90, payloadBytes: privatePayload.length } });
  assert.deepEqual(report.broadcasts, { frames: 1, bytes: 6 });
  assert.equal(report.eventPayloadBytes, 6); assert.equal(report.alarms.set, 1);
  assert.equal(report.sql.webService.statements, 1); assert.equal(report.upstream.modelBytes, 90);
  assert.equal(sends, 1); assert.equal(alarms, 1);
  assert.equal(JSON.stringify(report).includes(privatePayload), false, 'private stream payload is not retained in a report');
  report.upstream.modelBytes = 0; assert.equal(meter.read()!.upstream.modelBytes, 90, 'reports cannot mutate counters');
  meter.begin(crypto.randomUUID()); assert.equal(meter.read()!.upstream.modelBytes, 0);
  assert.equal(meter.read()!.instanceId, report.instanceId, 'callers detect instance changes across the window');
});
