import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';
import { messageText } from '../../shared/conversation/content';
import { StreamSync } from '../../shared/streaming/sync';
import type { ProviderKind } from '../../shared/providers/types';
import type { Snapshot, SyncPacket } from '../../shared/streaming/protocol';
import type { Submission } from '../../shared/conversation/types';
import type { ToolResourceWindow, ToolWorkflowMeasurements } from './support/resources';

const { values } = parseArgs({ options: { chunks: { type: 'string', default: '120' }, interval: { type: 'string', default: '25' },
  size: { type: 'string', default: '200' }, port: { type: 'string', default: '5185' }, scenario: { type: 'string', default: 'all' },
  output: { type: 'string', default: join(tmpdir(), 'everchat-tool-measurements.json') } } });
function integer(value: string | undefined, min: number, max: number) {
  const n = Number(value); assert.ok(Number.isInteger(n) && n >= min && n <= max, `Expected integer in ${min}..${max}`); return n;
}
const chunks = integer(values.chunks, 1, 200), interval = integer(values.interval, 1, 500), size = integer(values.size, 4, 750);
assert.ok(chunks * size <= 90_000, 'Final output must fit the bounded message limit');
const port = integer(values.port, 1024, 65535), origin = `http://127.0.0.1:${port}`;
const runtimeId = crypto.randomUUID();
const state = await mkdtemp(join(tmpdir(), 'everchat-tool-baseline-'));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EVERCHAT_TEST_STATE: state,
    EVERCHAT_MOCK_PROVIDER: '1', EVERCHAT_TOOL_METRICS: '1', EVERCHAT_GENERATION_METRICS: '0', EVERCHAT_MEASUREMENT_RUN: runtimeId,
    EVERCHAT_TOOL_WORKLOAD: JSON.stringify({ chunks, interval, size }), WRANGLER_LOG_PATH: join(state, 'wrangler.log') },
});
let serverError: Error | undefined, cookie = '', runtimeLog = '', complete = false;
server.on('error', (error) => { serverError = error; });
for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { runtimeLog = (runtimeLog + String(chunk)).slice(-32_768); });
const sockets = new Set<WebSocket>();
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, Cookie: cookie,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  if (path === '/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<T>;
}
type ConversationSample = { report: ToolResourceWindow | null; databaseBytes: number; alarmAt: number | null; pendingSearch: number; pendingNotifications: number;
  privateStreams: number; privatePayloads: number; retainedContexts: number;
  task: { status: string; round: number; modelRequests: number; toolRequests: number } | null;
  workflow: { status: string; output?: { status: string; localMeasurement: ToolWorkflowMeasurements } } | null };
type LibrarySample = { report: ToolResourceWindow | null; databaseBytes: number; alarmAt: number | null; pendingBackfills: number; usedToday: number };
const sampleConversation = (id: string, taskId?: string, windowId?: string) => api<ConversationSample>(`/__test/resources/${id}`, { taskId, windowId });
const sampleLibrary = (windowId?: string) => api<LibrarySample>('/__test/resources/library', { windowId });
async function subscriber(id: string, disconnect: boolean) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`, { headers: { Cookie: cookie, Origin: origin } });
  sockets.add(socket);
  const observed = { frames: 0, bytes: 0, disconnected: false }, sync = new StreamSync(); let failure: unknown;
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket readiness timed out')), 10_000);
    socket.on('error', (error) => { clearTimeout(timer); failure = error; reject(error); });
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      observed.frames++; observed.bytes += bytes.byteLength;
      try {
        const packet = JSON.parse(bytes.toString()) as SyncPacket; sync.receive(packet);
        if (packet.type === 'ready') { clearTimeout(timer); ready(); }
        if (packet.type === 'preview' && disconnect) { observed.disconnected = true; socket.close(); }
        else if (packet.type === 'preview') socket.send(JSON.stringify({ type: 'preview-ack', runId: packet.batch.runId, messageId: packet.batch.messageId, offset: packet.batch.endOffset }));
      } catch (error) { failure = error; clearTimeout(timer); socket.close(); reject(error); }
    });
  });
  return { socket, observed, snapshot: () => { if (failure) throw failure; return sync.durable; } };
}
const protocols: ProviderKind[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
const scenarios = [...protocols.map((protocol) => ({ name: `online-${protocol}`, protocol, disconnect: false, mode: 'success' })),
  { name: 'disconnected-openai-chat', protocol: 'openai-chat' as const, disconnect: true, mode: 'success' },
  { name: 'service-rejected', protocol: 'openai-chat' as const, disconnect: false, mode: 'rejected' },
  { name: 'round-limit', protocol: 'openai-chat' as const, disconnect: false, mode: 'loop' }];
const results: unknown[] = [];
try {
  assert.ok(values.scenario === 'all' || scenarios.some((scenario) => scenario.name === values.scenario), 'Unknown scenario');
  const readyDeadline = Date.now() + 30_000;
  while (true) {
    if (serverError) throw serverError;
    assert.ok(server.exitCode === null && server.signalCode === null, 'Fixture server exited before readiness');
    try { if ((await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Runtime startup. */ }
    assert.ok(Date.now() < readyDeadline, 'Fixture startup timed out'); await pause(100);
  }
  const anonymous = await fetch(`${origin}/api/__test/resources/library`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('X-EverChat-Measurement-Run'), runtimeId, 'Port belongs to another runtime; refusing to log in or change its settings');
  await api('/login', { password: process.env.EVERCHAT_TEST_PASSWORD ?? 'everchat-local' });
  const providers = protocols.map((provider) => ({ id: crypto.randomUUID(), name: provider, provider, baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
    models: [`tools-service-${provider}`, `tools-loop-${provider}`].map((id) => ({ id, name: id, enabled: true, reasoningSupport: 'supported', metadataOverrides: { toolCalls: true, contextWindow: 131072 } })) }));
  await api('/settings/providers', { providers, activeProviderId: providers[0].id, activeModel: providers[0].models[0].id,
    systemPrompt: '', showReasoning: true, maxOutputTokens: null }, 'PUT');
  await api('/settings/web-tools', { provider: 'tavily', apiKey: 'tvly-isolated-fixture-key', dailyLimit: 1000 }, 'PUT');
  for (const scenario of scenarios) {
    if (values.scenario !== 'all' && scenario.name !== values.scenario) continue;
    const id = crypto.randomUUID(), requestId = crypto.randomUUID(), windowId = crypto.randomUUID();
    await api('/conversations', { id, title: scenario.name });
    await api(`/__test/conversations/${id}/tool-runtime`, { taskId: requestId, fault: scenario.mode === 'rejected' ? 'service-401' : 'service' });
    const warmDeadline = Date.now() + 10_000;
    while (true) {
      const warm = await sampleLibrary(); if (!warm.pendingBackfills && warm.alarmAt === null) break;
      assert.ok(Date.now() < warmDeadline, 'Library warmup timed out'); await pause(100);
    }
    const libraryStart = await sampleLibrary(windowId), conversationStart = await sampleConversation(id, undefined, windowId);
    assert.ok(libraryStart.report && conversationStart.report, 'Measurement windows must be armed');
    const live = await subscriber(id, scenario.disconnect);
    const provider = providers.find((item) => item.provider === scenario.protocol)!;
    const input = { parentId: null, requestId, content: 'Deterministic bounded web tool workload', selection: { providerId: provider.id,
      model: `tools-${scenario.mode === 'loop' ? 'loop' : 'service'}-${scenario.protocol}` }, showReasoning: true, tools: ['web_search', 'read_webpage'] };
    const submission = await api<Submission>(`/conversations/${id}/messages`, input);
    assert.deepEqual(await api(`/conversations/${id}/messages`, input), submission, 'Duplicate acceptance must return the same run');
    const deadline = Date.now() + chunks * interval * 2 + 60_000;
    let sample: ConversationSample;
    let nextLibraryProbe = 0;
    do {
      await pause(250); live.snapshot(); sample = await sampleConversation(id, requestId);
      // Keep the local in-memory counter window observable while the final
      // model is running. These raw diagnostic reads are excluded from SQL
      // totals; this run cannot measure natural hibernation or active GB-s.
      if (Date.now() >= nextLibraryProbe) { await sampleLibrary(); nextLibraryProbe = Date.now() + 1000; }
      assert.ok(Date.now() < deadline, `${scenario.name}: completion timed out: ${JSON.stringify({ task: sample.task, workflow: sample.workflow?.status,
        pendingSearch: sample.pendingSearch, pendingNotifications: sample.pendingNotifications, alarmAt: sample.alarmAt })}`);
    } while (!sample.task || sample.task.status === 'active' || sample.workflow?.status !== 'complete' || sample.pendingSearch || sample.pendingNotifications || sample.alarmAt !== null);
    const snapshot = await api<Snapshot>(`/conversations/${id}`), answer = snapshot.messages[1];
    const expectedModels = scenario.mode === 'loop' ? 4 : scenario.mode === 'rejected' ? 1 : 2;
    const expectedTools = scenario.mode === 'loop' ? 6 : scenario.mode === 'rejected' ? 1 : 2;
    assert.equal(answer.status, scenario.mode === 'success' ? 'completed' : 'failed');
    if (scenario.mode === 'success') assert.equal(messageText(answer), (scenario.protocol === 'openai-chat' ? '先查阅资料。\n' : '') + ('x'.repeat(size - 2) + '🙂').repeat(chunks));
    else assert.ok(answer.error?.includes(scenario.mode === 'loop' ? '轮数' : '密钥'));
    if (scenario.disconnect) assert.ok(live.observed.disconnected);
    else {
      const syncDeadline = Date.now() + 5000;
      while (live.snapshot().seq < snapshot.seq) { assert.ok(Date.now() < syncDeadline, 'Subscriber terminal state timed out'); await pause(10); }
      assert.deepEqual(live.snapshot(), snapshot, 'Public stream and persisted state must agree');
    }
    live.socket.close(); sockets.delete(live.socket);
    // Allow terminal notifications/index maintenance to settle, then obtain a
    // final read through unwrapped SQL; diagnostic polling does not inflate it.
    await pause(300);
    sample = await sampleConversation(id, requestId); const library = await sampleLibrary();
    assert.ok(sample.report, 'Conversation reset lost the full measurement window');
    assert.ok(library.report, 'Library reset lost the full measurement window');
    assert.equal(sample.report.instanceId, conversationStart.report.instanceId, 'DO reset invalidated the full measurement window');
    assert.equal(library.report.instanceId, libraryStart.report.instanceId, 'Library reset invalidated the full measurement window');
    assert.equal(sample.report.windowId, windowId); assert.equal(library.report.windowId, windowId);
    assert.equal(sample.report.upstream.modelRequests, expectedModels); assert.equal(sample.report.upstream.toolRequests, expectedTools);
    assert.equal(sample.task!.modelRequests, expectedModels); assert.equal(sample.task!.toolRequests, expectedTools);
    assert.equal(library.usedToday - libraryStart.usedToday, expectedTools);
    assert.equal(sample.privateStreams + sample.privatePayloads + sample.retainedContexts + sample.pendingSearch + sample.pendingNotifications, 0);
    assert.equal(library.pendingBackfills, 0);
    assert.equal(sample.alarmAt, null); assert.equal(library.alarmAt, null, 'All scheduled cleanup must drain inside the window');
    const workflow = sample.workflow!.output!.localMeasurement;
    assert.ok(workflow.steps.length > 0 && workflow.waits.length > 0, 'The actual Workflow must expose step measurements');
    assert.ok(workflow.steps.every((entry) => entry.attempts > 0 && entry.resultBytes > 0));
    assert.equal(workflow.steps.filter((entry) => entry.name.startsWith('tool-')).length, expectedTools);
    assert.equal(workflow.steps.filter((entry) => entry.name.startsWith('schedule-model-')).length, expectedModels);
    assert.equal(sample.report.streams.private.wireBytes, sample.report.upstream.modelBytes, 'Every upstream byte must enter the private journal exactly once');
    assert.ok(sample.report.streams.public.wireBytes > 0 && sample.report.eventPayloadBytes > 0);
    const total = (report: ToolResourceWindow) => Object.values(report.sql).reduce((sum, value) => sum + value.rowsWritten, 0);
    results.push({ scenario: scenario.name, protocol: scenario.protocol, status: answer.status,
      conversation: sample, library: { ...library, usedInWindow: library.usedToday - libraryStart.usedToday }, client: live.observed });
    console.log(JSON.stringify({ scenario: scenario.name, modelRequests: expectedModels, toolRequests: expectedTools,
      conversationSqlRowsWritten: total(sample.report), librarySqlRowsWritten: total(library.report), workflowSteps: workflow.steps.length,
      workflowWaits: workflow.waits.length, upstreamBytes: sample.report.upstream.modelBytes,
      privateStreamBytes: sample.report.streams.private.wireBytes, publicStreamBytes: sample.report.streams.public.wireBytes }));
  }
  const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, runtime: 'local Cloudflare fixture', capturedAt: new Date().toISOString(),
    workload: { chunks, intervalMs: interval, finalCharactersPerChunk: size, toolResponseDelayMs: 1500, duplicateAcceptance: true, scenario: values.scenario },
    scope: 'Warm initialized objects: before acceptance/subscription to terminal Workflow, private cleanup, search outbox drain and no pending Conversation/Library alarms. Native SQL cursor counters include API, Alarm and indexing work; diagnostic reads and fixture SQL excluded. Read-only probes keep local counter windows observable, so natural hibernation is not measured. Workflow callback attempts and serialized reference sizes only. No CPU, billed requests, active GB-s, Workflow engine storage, account quotas or real upstream quality measured. No paid calls.',
    results }, null, 2) + '\n');
  console.log(`Saved ${output}`);
  complete = true;
} finally {
  for (const socket of sockets) socket.terminate();
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((done) => server.once('exit', () => done())); server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000); await exited; clearTimeout(force);
  }
  if (!complete) await writeFile(join(tmpdir(), 'everchat-tool-baseline-failure.log'), runtimeLog);
  await rm(state, { recursive: true, force: true });
}
