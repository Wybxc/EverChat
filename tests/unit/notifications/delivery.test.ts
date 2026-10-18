import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CompletionOutbox, COMPLETION_OUTBOX_SCHEMA } from '../../../worker/notifications/outbox';
import { NotificationRegistry } from '../../../worker/notifications/registry';
import {
  completionId,
  NOTIFICATION_TTL,
  type AnswerCompletion,
  type NotificationDevice,
} from '../../../shared/notifications/protocol';
import type { SqlQuery } from '../../../worker/generation/metrics';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...params: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(params as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  let time = 100_000;
  const now = () => time;
  const completion: AnswerCompletion = {
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    completedAt: time,
  };
  return {
    db,
    query,
    now,
    completion,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const device = (push = true): NotificationDevice => ({
  instanceId: crypto.randomUUID(),
  revision: 1,
  mode: 'unfocused',
  subscription: push
    ? {
        endpoint: 'https://web.push.apple.com/test',
        expirationTime: null,
        keys: { auth: 'a'.repeat(22), p256dh: 'a'.repeat(87) },
      }
    : null,
});
function registry(t: TestContext) {
  const f = fixture(t),
    sockets: ReturnType<typeof socket>[] = [],
    log = t.mock.method(console, 'info', () => {});
  Object.defineProperty(globalThis, 'WebSocketRequestResponsePair', {
    value: class {},
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'WebSocketRequestResponsePair');
  });
  const context = {
    setWebSocketAutoResponse() {},
    getWebSockets: (id?: string) => sockets.filter((s) => !id || s.instanceId === id),
  } as unknown as DurableObjectState;
  const sent: AnswerCompletion[] = [],
    targets: string[] = [];
  let status = 201,
    exists = true,
    failure: unknown;
  const reader = () =>
    new NotificationRegistry(
      context,
      f.query,
      async (device, completion) => {
        sent.push(completion);
        targets.push(device.instanceId);
        if (failure) throw failure;
        return { status };
      },
      () => exists,
      f.now,
    );
  let store = reader();
  function socket(instanceId: string, expires = 10000, owner = 'owner') {
    let attachment: unknown = { instanceId, owner, expires };
    const packets: { type: string; id?: string }[] = [];
    return {
      instanceId,
      packets,
      readyState: 1,
      closed: false,
      send: (data: string) => packets.push(JSON.parse(data)),
      deserializeAttachment: () => attachment,
      serializeAttachment: (value: unknown) => {
        attachment = value;
      },
      close() {
        this.closed = true;
      },
    };
  }
  return {
    ...f,
    sent,
    targets,
    sockets,
    logs: () => log.mock.calls.map((call) => call.arguments),
    fail: (error: unknown) => {
      failure = error;
    },
    get store() {
      return store;
    },
    reopen() {
      store = reader();
    },
    status: (value: number) => {
      status = value;
    },
    remove: () => {
      exists = false;
    },
    connect: (id: string, expires?: number, owner?: string) => {
      const ws = socket(id, expires, owner);
      sockets.push(ws);
      return ws;
    },
    reply: (ws: ReturnType<typeof socket>, id: string, foreground: boolean) =>
      store.message(ws as unknown as WebSocket, JSON.stringify({ type: 'check', id, foreground })),
  };
}
test('completion outbox persists only minimal delivery intent, survives reopening and retries without duplicating concurrent sends', async (t) => {
  const f = fixture(t);
  f.query(COMPLETION_OUTBOX_SCHEMA);
  let store = new CompletionOutbox(f.query, f.now),
    sends = 0;
  store.record(f.completion);
  store.record(f.completion);
  assert.equal(f.query('SELECT * FROM answer_notification_outbox').toArray().length, 1);
  await store.flush(async () => {
    sends++;
    throw new Error('offline');
  });
  assert.equal(store.nextAlarm(), f.now() + 1000);
  store = new CompletionOutbox(f.query, f.now);
  f.advance(1000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = store.flush(async (payload) => {
    sends++;
    assert.deepEqual(payload, f.completion);
    await gate;
  });
  await store.flush(async () => {
    throw new Error('duplicate');
  });
  release();
  await first;
  assert.equal(sends, 2);
  assert.equal(store.nextAlarm(), null);
  store.record(f.completion);
  f.advance(NOTIFICATION_TTL);
  await store.flush(async () => {
    throw new Error('expired');
  });
  assert.equal(store.nextAlarm(), null);
});
test('device ownership, endpoint validation, monotonic revisions and enable time prevent takeover or historical notifications', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  assert.throws(() => f.store.save('other', { ...d, revision: 2 }), /不属于/);
  const request = new Request('https://chat.example.com/api/notifications/sync');
  assert.throws(() => f.store.connect(request, 'owner', 10000, 'invalid'), /格式无效/);
  assert.throws(() => f.store.connect(request, 'other', 10000, d.instanceId), /不属于/);
  assert.throws(() => f.store.connect(request, 'owner', 10000, crypto.randomUUID()), /实时连接/);
  for (const endpoint of [
    'http://localhost/push',
    'https://fcm.googleapis.com.evil.example/',
    'https://127.0.0.1/',
    'https://user@fcm.googleapis.com/',
  ])
    assert.throws(
      () =>
        f.store.save('owner', {
          ...d,
          revision: 2,
          subscription: { ...d.subscription!, endpoint },
        }),
      /不支持/,
    );
  f.store.save('owner', { ...d, mode: 'never', revision: 3 });
  assert.equal(f.store.save('owner', { ...d, revision: 2 }).mode, 'never');
  f.advance(1000);
  f.store.save('owner', { ...d, revision: 4 });
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.equal(f.sent.length, 0);
  f.store.enqueue({ ...f.completion, completedAt: f.now() });
  await f.store.flush();
  assert.equal(f.sent.length, 1);
});
test('a foreground window suppresses conditional push across all tabs; a later background completion is sent once after restart', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const a = f.connect(d.instanceId),
    b = f.connect(d.instanceId);
  f.store.enqueue(f.completion);
  await f.store.flush();
  const token = a.packets[0].id!;
  assert.equal(b.packets[0].id, token);
  f.reply(a, token, false);
  f.reply(b, token, true);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 0);
  const next = { ...f.completion, messageId: crypto.randomUUID(), completedAt: f.now() };
  f.store.enqueue(next);
  await f.store.flush();
  const second = a.packets.at(-1)!.id!;
  f.reply(a, second, false);
  f.reply(b, second, false);
  f.reopen();
  f.advance(1000);
  await f.store.flush();
  f.store.enqueue(next);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(completionId(f.sent[0]), completionId(next));
});
test('each retry checks focus again and stale replies cannot suppress a later attempt', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId);
  f.status(503);
  f.store.enqueue(f.completion);
  await f.store.flush();
  const old = ws.packets.at(-1)!.id!;
  f.reply(ws, old, false);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  await f.store.flush();
  const fresh = ws.packets.at(-1)!.id!;
  assert.notEqual(fresh, old);
  f.reply(ws, old, false);
  f.reply(ws, fresh, true);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
});
test('an active desktop without notification permission suppresses mobile conditional delivery but not always mode', async (t) => {
  const f = registry(t),
    mobile = device(),
    always = { ...device(), mode: 'always' as const };
  f.store.save('owner', mobile);
  f.store.save('owner', always);
  // Presence does not require a persisted device or a Push subscription.
  const desktop = f.connect(crypto.randomUUID());
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.deepEqual(f.targets, [always.instanceId]);
  assert.equal(desktop.packets.length, 1);
  f.reply(desktop, desktop.packets[0].id!, true);
  f.reopen();
  f.advance(1000);
  await f.store.flush();
  assert.deepEqual(f.targets, [always.instanceId]);
  assert.equal(f.query('SELECT * FROM notification_devices').toArray().length, 2);
  const next = { ...f.completion, messageId: crypto.randomUUID(), completedAt: f.now() };
  f.store.enqueue(next);
  await f.store.flush();
  f.reply(desktop, desktop.packets.at(-1)!.id!, false);
  f.advance(1000);
  await f.store.flush();
  assert.deepEqual(f.targets, [always.instanceId, always.instanceId, mobile.instanceId]);
});
test('disabled desktop notifications still participate in account focus checks, including local-only delivery', async (t) => {
  const f = registry(t),
    desktop = { ...device(false), mode: 'never' as const },
    local = device(false),
    mobile = device();
  for (const d of [desktop, local, mobile]) f.store.save('owner', d);
  const active = f.connect(desktop.instanceId),
    localWindow = f.connect(local.instanceId);
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(active.packets.length, 2);
  for (const packet of active.packets) f.reply(active, packet.id!, true);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 0);
  assert.ok(localWindow.packets.every((packet) => packet.type === 'check'));
});
test('another account cannot observe or confirm a focus check, even with a copied token', async (t) => {
  const f = registry(t),
    mobile = device(),
    other = device();
  f.store.save('owner', mobile);
  f.store.save('other', other);
  const desktop = f.connect(crypto.randomUUID()),
    stranger = f.connect(other.instanceId, undefined, 'other');
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.equal(desktop.packets.length, 1);
  assert.equal(stranger.packets.length, 1);
  assert.notEqual(desktop.packets[0].id, stranger.packets[0].id);
  f.reply(stranger, desktop.packets[0].id!, true);
  f.reply(stranger, stranger.packets[0].id!, true);
  f.advance(1000);
  await f.store.flush();
  assert.deepEqual(f.targets, [mobile.instanceId]);
});
test('simultaneous foreground completions remain suppressed when focus replies arrive out of order', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId);
  f.store.enqueue(f.completion);
  f.store.enqueue({
    ...f.completion,
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
  });
  await f.store.flush();
  assert.equal(ws.packets.length, 2);
  for (const packet of [...ws.packets].reverse()) f.reply(ws, packet.id!, true);
  f.reopen();
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 0);
});
test('a stale or duplicate background reply cannot undo a foreground confirmation', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId);
  f.status(503);
  f.store.enqueue(f.completion);
  await f.store.flush();
  const old = ws.packets.at(-1)!.id!;
  f.reply(ws, old, false);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  await f.store.flush();
  const fresh = ws.packets.at(-1)!.id!;
  f.reply(ws, fresh, true);
  f.reply(ws, old, false);
  f.reply(ws, fresh, false);
  f.advance(1000);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
});
test('focus confirmations received after the decision deadline do not suppress delivery', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId);
  f.store.enqueue(f.completion);
  await f.store.flush();
  f.advance(1001);
  f.reply(ws, ws.packets[0].id!, true);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
});
test('closed or expired sessions do not prevent push; stopping a device, deleted conversations and expiry cancel pending work', async (t) => {
  const f = registry(t),
    d = device();
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId, 1);
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(ws.closed, true);
  const next = { ...f.completion, messageId: crypto.randomUUID() };
  f.store.enqueue(next);
  f.store.save('owner', { ...d, revision: 2, mode: 'never' });
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  f.store.save('owner', { ...d, revision: 3 });
  f.store.enqueue({ ...next, completedAt: f.now() });
  f.remove();
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  f.advance(NOTIFICATION_TTL);
  await f.store.flush();
  assert.equal(f.store.nextAlarm(), Infinity);
});
test('always mode bypasses focus checks, 410 invalidates push, local delivery has one channel and mode changes cancel old jobs', async (t) => {
  const f = registry(t),
    d = { ...device(), mode: 'always' as const };
  f.store.save('owner', d);
  const ws = f.connect(d.instanceId);
  f.status(410);
  f.store.enqueue(f.completion);
  await f.store.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(ws.packets.length, 0);
  const next = { ...f.completion, messageId: crypto.randomUUID() };
  f.store.enqueue(next);
  await f.store.flush();
  assert.equal(ws.packets[0].type, 'local');
  assert.equal(f.sent.length, 1);
  f.store.enqueue({ ...next, messageId: crypto.randomUUID() });
  f.store.save('owner', { ...d, revision: 2, mode: 'never' });
  await f.store.flush();
  assert.equal(ws.packets.length, 1);
});

test('delivery diagnostics distinguish gateway outcomes and never retain endpoints, keys or exception messages', async (t) => {
  const f = registry(t),
    d = { ...device(), mode: 'always' as const };
  f.store.save('owner', d);
  for (const status of [201, 302, 403, 429, 503]) {
    f.status(status);
    f.store.enqueue({ ...f.completion, messageId: crypto.randomUUID() });
    await f.store.flush();
  }
  const failure = new Error(`Failed request to ${d.subscription!.endpoint} with secret-value`);
  // Even a custom error name must not be able to smuggle sensitive text into logs.
  failure.name = d.subscription!.keys.auth;
  f.fail(failure);
  f.store.enqueue({ ...f.completion, messageId: crypto.randomUUID() });
  await f.store.flush();
  const logs = f.logs();
  assert.equal(logs.length, 6);
  assert.deepEqual(
    logs.map(([, data]) => data.result),
    ['accepted', 'rejected', 'rejected', 'retry', 'retry', 'retry'],
  );
  assert.equal(logs.at(-1)![1].errorType, 'UnknownError');
  for (const [event, data] of logs) {
    assert.equal(event, 'EverChat notification delivery');
    assert.ok(
      Object.keys(data).every((key) =>
        [
          'completionId',
          'instanceId',
          'attempt',
          'status',
          'result',
          'elapsedMs',
          'errorType',
        ].includes(key),
      ),
    );
  }
  const serialized = JSON.stringify(logs);
  for (const sensitive of [
    d.subscription!.endpoint,
    d.subscription!.keys.auth,
    d.subscription!.keys.p256dh,
    'secret-value',
  ])
    assert.equal(serialized.includes(sensitive), false);
});
