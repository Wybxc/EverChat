import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket, { type ClientOptions } from 'ws';
import type { Snapshot, SyncPacket } from '../../../shared/streaming/protocol';
import { StreamSync } from '../../../shared/streaming/sync';

export function measurementApi(options: {
  origin: string;
  prefix?: string;
  headers: () => Record<string, string>;
  timeout?: number;
}) {
  const request = (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    headers?: Record<string, string>,
  ) =>
    fetch(`${options.origin}${options.prefix ?? '/api'}${path}`, {
      method,
      redirect: 'error',
      headers: {
        Origin: options.origin,
        ...options.headers(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
    });
  return {
    request,
    async api<T>(path: string, body?: unknown, method?: string): Promise<T> {
      const response = await request(path, body, method);
      assert.ok(
        response.ok,
        `${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: HTTP ${response.status}`,
      );
      return response.json() as Promise<T>;
    },
  };
}

export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 45_000,
  interval = 50,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${label}: timed out`);
    await pause(interval);
  }
}

/** One protocol consumer for local diagnostics and isolated deployed validation. */
export async function subscribe(options: {
  origin: string;
  id: string;
  baseline: Snapshot;
  headers: Record<string, string>;
  sockets: Set<WebSocket>;
  agent?: ClientOptions['agent'];
  timeout?: number;
  maxPayload?: number;
  disconnect?: boolean;
  acknowledge?: boolean;
}) {
  const { baseline } = options;
  const socket = new WebSocket(
    `${options.origin.replace(/^http/, 'ws')}/api/conversations/${options.id}/sync?after=${baseline.seq}&epoch=${baseline.epoch ?? ''}`,
    {
      agent: options.agent,
      handshakeTimeout: options.timeout ?? 30_000,
      ...(options.maxPayload ? { maxPayload: options.maxPayload } : {}),
      headers: { ...options.headers, Origin: options.origin },
    },
  );
  options.sockets.add(socket);
  const sync = new StreamSync(baseline);
  const observed = { frames: 0, bytes: 0, disconnected: false };
  let failure: unknown, code: number | undefined;
  socket.on('close', (value) => {
    code = value;
    options.sockets.delete(socket);
  });
  try {
    await new Promise<void>((ready, reject) => {
      let initialized = false;
      const fail = (error: unknown) => {
        failure = error;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('Subscription timed out'));
        socket.terminate();
      }, options.timeout ?? 30_000);
      socket.on('error', fail);
      socket.on('close', (value) => {
        clearTimeout(timer);
        if (!initialized) fail(new Error(`Subscription closed before ready: ${value}`));
      });
      socket.on('message', (value) => {
        const bytes = Buffer.isBuffer(value)
          ? value
          : Array.isArray(value)
            ? Buffer.concat(value)
            : Buffer.from(value);
        observed.frames++;
        observed.bytes += bytes.byteLength;
        try {
          const packet = JSON.parse(bytes.toString()) as SyncPacket;
          sync.receive(packet);
          if (packet.type === 'ready') {
            initialized = true;
            clearTimeout(timer);
            ready();
          }
          if (packet.type === 'preview' && options.disconnect && !observed.disconnected) {
            observed.disconnected = true;
            socket.close(1000);
          } else if (
            packet.type === 'preview' &&
            options.acknowledge !== false &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.send(
              JSON.stringify({
                type: 'preview-ack',
                runId: packet.batch.runId,
                messageId: packet.batch.messageId,
                offset: packet.batch.endOffset,
              }),
            );
          }
        } catch (error) {
          fail(error);
          socket.terminate();
        }
      });
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  const check = () => {
    if (failure) throw failure;
  };
  return {
    socket,
    sync,
    observed,
    check,
    snapshot: () => {
      check();
      return sync.durable;
    },
    code: () => code,
    closed: () => code !== undefined,
  };
}

export async function writeReport(path: string, report: unknown) {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
}
