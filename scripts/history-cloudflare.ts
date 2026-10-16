import { messageText } from '../shared/conversation/content';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent } from 'node:https';
import WebSocket from 'ws';
import type { Snapshot, SyncPacket } from '../shared/streaming/protocol';
import { StreamSync } from '../shared/streaming/sync';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, credentials: { type: 'string' }, source: { type: 'string' },
  output: { type: 'string', default: '/tmp/everchat-history-cloudflare.json' },
} });
assert.ok(values.url && values.credentials, '--url and --credentials are required');
const url = new URL(values.url);
assert.equal(url.protocol, 'https:');
assert.ok(url.hostname.startsWith('everchat-stream-validation.') && url.hostname.endsWith('.workers.dev'), 'Use only the isolated validation Worker');
const origin = url.origin;
const { APP_PASSWORD } = JSON.parse(await readFile(values.credentials, 'utf8')) as { APP_PASSWORD: string };
assert.ok(APP_PASSWORD?.length >= 32);
let cookie = '';
const agent = new Agent({ proxyEnv: process.env });
const sockets = new Set<WebSocket>();
function request(path: string, body?: unknown) {
  return fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body); assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  if (path === '/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<T>;
}
type Seed = { messages: number; contentCharacters: number; reasoningCharacters: number; databaseBytes: number };
type History = { pairs: number; conversationId: string; seed: Seed };
function validate(snapshot: Snapshot, history: History) {
  assert.equal(snapshot.seq, 501); assert.equal(snapshot.messages.length, history.seed.messages);
  for (const [index, message] of snapshot.messages.entries()) {
    assert.equal(message.status, 'completed'); assert.equal(message.createdAt, index);
    assert.equal(messageText(message), index % 2 ? '正文🙂'.repeat(22500) : '历史🙂'.repeat(4000));
    assert.equal(messageText(message, 'reasoning'), index % 2 ? '思考🙂'.repeat(22500) : '');
    if (index % 2) assert.equal(message.parentId, snapshot.messages[index - 1].id);
  }
}
async function replay(history: History, snapshot?: Snapshot) {
  const began = Date.now(), sync = new StreamSync(snapshot);
  const socket = new WebSocket(`${origin.replace('https:', 'wss:')}/api/conversations/${history.conversationId}/sync?after=${snapshot?.seq ?? 0}`,
    { agent, handshakeTimeout: 30000, maxPayload: 32 * 1024 * 1024, headers: { Cookie: cookie, Origin: origin } });
  sockets.add(socket);
  let frames = 0, bytes = 0, closed = false, ready = false;
  const timer = setTimeout(() => socket.terminate(), 60000);
  try {
    await new Promise<void>((done, reject) => {
      socket.on('error', reject);
      socket.on('close', (code) => { closed = true; if (!ready) reject(new Error(`Replay closed before ready: ${code}`)); });
      socket.on('message', (value) => {
        try {
          frames++; bytes += Buffer.byteLength(value.toString());
          const packet = JSON.parse(value.toString()) as SyncPacket; sync.receive(packet);
          if (packet.type === 'ready') { ready = true; done(); }
        } catch (error) { reject(error); }
      });
    });
    validate(sync.durable, history); if (snapshot) assert.deepEqual(sync.durable, snapshot);
    socket.close(1000);
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) await pause(25);
    assert.equal(closed, true, 'Cleanly close the replay socket');
    return { passed: true, frames, bytes, elapsedMs: Date.now() - began };
  } finally { clearTimeout(timer); socket.terminate(); sockets.delete(socket); }
}
const startedAt = new Date().toISOString(), results: Record<string, unknown>[] = [];
try {
  await api('/login', { password: APP_PASSWORD });
  let histories: History[] = [];
  if (values.source) {
    const source = JSON.parse(await readFile(values.source, 'utf8')) as { workerName: string; complete: boolean; results: History[] };
    assert.equal(source.workerName, 'everchat-stream-validation'); assert.equal(source.complete, true);
    histories = source.results.map(({ pairs, conversationId, seed }) => ({ pairs, conversationId, seed }));
    assert.deepEqual(histories.map(({ pairs }) => pairs), [1, 4, 16]);
  } else {
    for (const pairs of [1, 4, 16]) {
      const conversationId = crypto.randomUUID();
      await api('/conversations', { id: conversationId, title: `History ${pairs} pairs` });
      const seed = await api<Seed>(`/__test/conversations/${conversationId}/history`, { pairs });
      histories.push({ pairs, conversationId, seed });
    }
  }
  for (const history of histories) {
    const reads: Record<string, unknown>[] = [];
    let snapshot: Snapshot | undefined;
    for (let index = 0; index < 5; index++) {
      const began = Date.now();
      try {
        const response = await request(`/conversations/${history.conversationId}`), text = await response.text();
        const bytes = Buffer.byteLength(text);
        let passed = response.status === 200;
        if (passed) {
          snapshot = JSON.parse(text) as Snapshot; validate(snapshot, history);
          assert.match(response.headers.get('content-type') ?? '', /application\/json/);
          assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        }
        reads.push({ status: response.status, passed, bytes, elapsedMs: Date.now() - began });
      } catch (error) { reads.push({ passed: false, failure: error instanceof Error ? error.name : 'UnknownError', elapsedMs: Date.now() - began }); }
    }
    const replays: Record<string, unknown>[] = [];
    for (const initial of [undefined, snapshot]) {
      if (initial === undefined && replays.length) continue;
      try { replays.push({ mode: initial ? 'latest-cursor' : 'full-snapshot', ...await replay(history, initial) }); }
      catch (error) { replays.push({ mode: initial ? 'latest-cursor' : 'full-snapshot', passed: false, failure: error instanceof Error ? error.name : 'UnknownError' }); }
    }
    results.push({ scenario: `history-${history.pairs}-pairs`, ...history, reads, replays });
    console.log(JSON.stringify({ pairs: history.pairs, httpPassed: reads.filter(({ passed }) => passed).length, replayPassed: replays.filter(({ passed }) => passed).length }));
  }
} finally {
  for (const socket of sockets) socket.terminate(); agent.destroy();
  const complete = results.length === 3;
  const passed = complete && results.every((result) => [...result.reads as { passed: boolean }[], ...result.replays as { passed: boolean }[]].every((item) => item.passed));
  const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, workerName: 'everchat-stream-validation', plan: 'Workers Free (user confirmed)', diagnosticCounters: false,
    suite: 'history', expectedScenarios: 3, complete, passed, startedAt, finishedAt: new Date().toISOString(), results,
    scope: 'Synthetic persisted completed history with compacted events. Five HTTP reads and full/latest WebSocket recovery. No suppliers, production data or configuration changes. Complete means all sizes exercised; passed separately records correctness.' }, null, 2) + '\n');
  if (!passed) process.exitCode = 1;
}
