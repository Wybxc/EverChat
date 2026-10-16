import { messageText } from '../shared/message-content';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';
import type { GenerationMeasurements } from '../shared/generation-metrics';
import { type Snapshot, type SyncPacket } from '../shared/types';
import { StreamSync } from '../shared/stream-sync';

const { values } = parseArgs({ options: {
  chunks: { type: 'string', default: '120' }, interval: { type: 'string', default: '25' },
  size: { type: 'string', default: '200' }, port: { type: 'string', default: '5184' },
  output: { type: 'string', default: join(tmpdir(), 'everchat-stream-measurements.json') },
} });
const integer = (value: string | undefined, min: number, max: number) => {
  const number = Number(value);
  assert.ok(Number.isInteger(number) && number >= min && number <= max, `Expected integer in ${min}..${max}`);
  return number;
};
const chunks = integer(values.chunks, 1, 1000), interval = integer(values.interval, 1, 500);
const size = integer(values.size, 4, 2000), port = integer(values.port, 1024, 65535);
const origin = `http://127.0.0.1:${port}`;
const state = await mkdtemp(join(tmpdir(), 'everchat-stream-baseline-'));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EVERCHAT_TEST_STATE: state, EVERCHAT_MOCK_PROVIDER: '1', EVERCHAT_GENERATION_METRICS: '1',
    WRANGLER_LOG_PATH: join(state, 'wrangler.log') },
});
let serverError: Error | undefined;
server.on('error', (error) => { serverError = error; });
// Drain output without printing provider configuration or local environment values.
server.stdout.resume(); server.stderr.resume();
const sockets = new Set<WebSocket>();
let cookie = '';

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  if (path === '/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<T>;
}

async function subscriber(id: string, disconnect: boolean) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`, { headers: { Cookie: cookie, Origin: origin } });
  sockets.add(socket);
  const observed = { frames: 0, bytes: 0, disconnected: false };
  const sync = new StreamSync();
  let failure: Error | undefined;
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket readiness timed out')), 10_000);
    socket.on('error', (error) => { clearTimeout(timer); failure = error; reject(error); });
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      observed.frames++; observed.bytes += bytes.byteLength;
      try {
        const packet = JSON.parse(bytes.toString()) as SyncPacket;
        sync.receive(packet);
        if (packet.type === 'preview') socket.send(JSON.stringify({ type: 'preview-ack', runId: packet.batch.runId, messageId: packet.batch.messageId, offset: packet.batch.endOffset }));
        if (packet.type === 'ready') { clearTimeout(timer); resolveReady(); }
        if (disconnect && packet.type === 'preview') {
          observed.disconnected = true; socket.close();
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Invalid sync packet');
        clearTimeout(timer); socket.close(); reject(failure);
      }
    });
  });
  return { socket, observed, snapshot: () => { if (failure) throw failure; return sync.durable; } };
}

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Fixture server exited before readiness');
    try { if ((await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Wait for local runtime startup. */ }
    assert.ok(Date.now() < deadline, 'Fixture server startup timed out');
    await pause(100);
  }
  assert.equal((await fetch(`${origin}/api/conversations/${crypto.randomUUID()}/measurements`)).status, 401,
    'Enabled diagnostic endpoints require authentication');
  await api('/login', { password: process.env.EVERCHAT_TEST_PASSWORD ?? 'everchat-local' });
  const providerId = crypto.randomUUID();
  const scenarios = [
    { name: 'online-text', kind: 'text', size, disconnect: false },
    { name: 'online-reasoning', kind: 'reasoning', size, disconnect: false },
    { name: 'disconnected-long', kind: 'long', size: Math.min(size * 4, Math.floor(90_000 / chunks)), disconnect: true },
  ];
  const models = scenarios.map((scenario) => ({ id: `benchmark-${scenario.kind}-${chunks}-${interval}-${scenario.size}`,
    name: scenario.name, enabled: true, reasoningSupport: 'supported' }));
  await api('/settings/providers', { providers: [{ id: providerId, name: 'Isolated benchmark fixture', provider: 'openai-chat',
    baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models }], activeProviderId: providerId,
    activeModel: models[0].id, systemPrompt: '', showReasoning: true, maxOutputTokens: null }, 'PUT');
  const results: { scenario: string; measurements: GenerationMeasurements; client: { frames: number; bytes: number; disconnected: boolean } }[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const id = crypto.randomUUID();
    await api('/conversations', { id, title: scenario.name });
    const live = await subscriber(id, scenario.disconnect);
    const { socket, observed } = live;
    const submission = await api<{ runId: string }>(`/conversations/${id}/messages`, { parentId: null, requestId: crypto.randomUUID(),
      content: 'Deterministic stream workload', selection: { providerId, model: models[index].id }, showReasoning: true });
    const deadline = Date.now() + chunks * interval + 30_000;
    let report: GenerationMeasurements | null;
    do {
      await pause(500);
      live.snapshot();
      report = await api<GenerationMeasurements | null>(`/conversations/${id}/measurements`);
      assert.ok(Date.now() < deadline, `${scenario.name}: generation timed out`);
    } while (!report || report.runId !== submission.runId);
    assert.equal(report.status, 'completed');
    assert.equal(report.coverage, 'claim-to-terminal', 'Runtime reset made the measurement window incomplete');
    assert.equal(report.textDeltas, chunks);
    assert.equal(report.reasoningDeltas, scenario.kind === 'reasoning' ? chunks : 0);
    const snapshot = await api<Snapshot>(`/conversations/${id}`);
    const answer = snapshot.messages.find((message) => message.runId === submission.runId && message.role === 'assistant')!;
    assert.equal(answer.status, 'completed');
    assert.equal(messageText(answer).length, chunks * Math.min(scenario.size, Math.floor(90_000 / chunks)));
    assert.equal(messageText(answer, 'reasoning').length, scenario.kind === 'reasoning' ? messageText(answer).length : 0);
    if (scenario.disconnect) {
      assert.ok(observed.disconnected, 'The subscriber must disconnect during generation');
      assert.ok(report.broadcastFrames > 0, 'The subscriber must receive part of the answer before disconnecting');
    }
    else {
      assert.ok(observed.bytes > 0 && report.broadcastFrames > 0);
      const syncDeadline = Date.now() + 5000;
      while (live.snapshot().seq < snapshot.seq) {
        assert.ok(Date.now() < syncDeadline, 'Subscriber did not receive the final committed state');
        await pause(10);
      }
      assert.deepEqual(live.snapshot(), snapshot, 'Incremental subscriber and persisted snapshot must agree');
    }
    socket.close(); sockets.delete(socket);
    results.push({ scenario: scenario.name, measurements: report, client: observed });
    console.log(JSON.stringify({ scenario: scenario.name, checkpoints: report.checkpoints, sqlRowsWritten: report.sqlRowsWritten,
      eventPayloadBytes: report.eventPayloadBytes, broadcastBytes: report.broadcastBytes, databaseBytes: report.databaseBytes }));
  }
  const output = resolve(values.output!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 2, runtime: 'local Cloudflare fixture', capturedAt: new Date().toISOString(),
    workload: { chunks, intervalMs: interval, baseCharactersPerChunk: size },
    scope: 'Claim-to-terminal Conversation SQL and broadcasts; excludes bootstrap, acceptance, Library, RPC metering, alarms and diagnostic persistence. elapsedMs is wall time, not CPU. No paid model calls.',
    results }, null, 2) + '\n');
  console.log(`Saved ${output}`);
} finally {
  for (const socket of sockets) socket.terminate();
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited; clearTimeout(force);
  }
  await rm(state, { recursive: true, force: true });
}
