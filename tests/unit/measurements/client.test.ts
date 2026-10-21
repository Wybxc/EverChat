import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { subscribe, until } from '../../../scripts/measurements/support/client';

test('measurement reconnects distinguish network and preview bounds from protocol damage', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets = new Set<WebSocket>();
  server.on('connection', (peer) => peer.send(JSON.stringify({ type: 'ready', seq: 0 })));
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const mode of ['network', 'bounded', 'clean', 'invalid-json', 'invalid-sync'] as const) {
      const connected = once(server, 'connection');
      const live = await subscribe({
        origin: `http://127.0.0.1:${address.port}`,
        id: 'test',
        baseline: { seq: 0, messages: [], epoch: 'epoch' },
        headers: {},
        sockets,
      });
      const [peer] = (await connected) as [WebSocket];
      if (mode === 'network') peer.terminate();
      else if (mode === 'invalid-json') peer.send('invalid JSON');
      else if (mode === 'invalid-sync') peer.send(JSON.stringify({ type: 'preview', batch: {} }));
      else peer.close(mode === 'bounded' ? 4002 : 1000);
      await until(live.closed, mode);
      assert.equal(live.recoverable(), mode === 'network' || mode === 'bounded', mode);
      if (mode.startsWith('invalid')) assert.throws(live.check);
      else live.check();
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('deployed measurement heartbeat checks sync and replaces a silent connection', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets = new Set<WebSocket>();
  const requests: string[] = [];
  server.on('connection', (peer) => {
    peer.send(JSON.stringify({ type: 'ready', seq: 0 }));
    peer.on('message', (value) => {
      requests.push(value.toString());
      if (value.toString() === 'ping') peer.send('pong');
    });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const live = await subscribe({
      origin: `http://127.0.0.1:${address.port}`,
      id: 'test',
      baseline: { seq: 0, messages: [], epoch: 'epoch' },
      headers: {},
      sockets,
      heartbeat: { interval: 10, timeout: 60 },
    });
    await until(live.closed, 'silent sync connection');
    live.check();
    assert.equal(live.recoverable(), true);
    assert.ok(requests.includes('ping'));
    assert.ok(requests.includes('session-check'));
    assert.deepEqual(JSON.parse(requests.find((value) => value.startsWith('{'))!), {
      type: 'sync-check',
      seq: 0,
      epoch: 'epoch',
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
