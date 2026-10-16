import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent } from 'node:https';
import WebSocket from 'ws';
import { messageText } from '../../../shared/conversation/content';
import { StreamSync } from '../../../shared/streaming/sync';
import type { ProviderKind } from '../../../shared/providers/types';
import type { Snapshot, SyncPacket } from '../../../shared/streaming/protocol';
import type { Submission } from '../../../shared/conversation/types';
import { TOOL_VALIDATION_WORKER, type ToolValidationConversation, type ToolValidationIdentity, type ToolValidationLibrary } from './validation';

export type ToolValidationSuite = 'functional' | 'large' | 'sustained';
export interface ToolValidationOptions {
  url: string; password: string; runId: string; output: string; suite: ToolValidationSuite;
  runtime: 'local' | 'cloudflare';
}
const protocols: ProviderKind[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
const terminal = (snapshot: Snapshot) => ['completed', 'failed', 'cancelled'].includes(snapshot.messages[1]?.status ?? '');
export async function runToolValidation(options: ToolValidationOptions) {
  assert.ok(['functional', 'large', 'sustained'].includes(options.suite), 'Unknown suite');
  const url = new URL(options.url), origin = url.origin;
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.equal(url.username + url.password, '');
  if (options.runtime === 'local') assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Local validation requires loopback');
  else assert.ok(url.protocol === 'https:' && url.hostname.startsWith(`${TOOL_VALIDATION_WORKER}.`) && url.hostname.endsWith('.workers.dev'), 'Use only the isolated tool validation Worker');
  assert.ok(options.password.length >= 32 && /^[0-9a-f-]{36}$/i.test(options.runId), 'Random validation credentials are required');
  const startedAt = new Date().toISOString(), results: Record<string, unknown>[] = [];
  let cookie = '', complete = false, identity: ToolValidationIdentity | undefined;
  const sockets = new Set<WebSocket>(), agent = options.runtime === 'cloudflare' ? new Agent({ proxyEnv: process.env }) : undefined;
  const observations = { publicSnapshotReads: 0, conversationStatusReads: 0, libraryStatusReads: 0 };
  async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers?: Record<string, string>) {
    return fetch(`${origin}/api${path}`, { method, redirect: 'error', headers: { Origin: origin, Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  }
  async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await request(path, body, method); assert.ok(response.ok, `${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: HTTP ${response.status}`);
    if (path === '/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response.json() as Promise<T>;
  }
  async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 45_000, interval = 50) {
    const deadline = Date.now() + timeout;
    while (!await check()) { assert.ok(Date.now() < deadline, `${label}: timed out`); await pause(interval); }
  }
  async function subscriber(id: string, disconnect = false) {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/conversations/${id}/sync?after=0`, {
      ...(agent ? { agent } : {}), handshakeTimeout: 30_000, headers: { Cookie: cookie, Origin: origin } });
    sockets.add(socket);
    const sync = new StreamSync(), observed = { frames: 0, bytes: 0, disconnected: false };
    let failure: unknown, closed = false;
    socket.on('close', () => { closed = true; sockets.delete(socket); });
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => { reject(new Error('Subscription timed out')); socket.terminate(); }, 30_000);
      socket.on('error', (error) => { failure = error; clearTimeout(timer); reject(error); });
      socket.on('message', (value) => {
        observed.frames++; observed.bytes += Buffer.byteLength(value.toString());
        try {
          const packet = JSON.parse(value.toString()) as SyncPacket; sync.receive(packet);
          if (packet.type === 'ready') { clearTimeout(timer); ready(); }
          if (packet.type === 'preview' && disconnect && !observed.disconnected) { observed.disconnected = true; socket.close(1000); }
          else if (packet.type === 'preview' && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'preview-ack', runId: packet.batch.runId, messageId: packet.batch.messageId, offset: packet.batch.endOffset }));
        } catch (error) { failure = error; clearTimeout(timer); reject(error); }
      });
    });
    return { socket, sync, observed, check: () => { if (failure) throw failure; }, closed: () => closed };
  }
  const library = () => { observations.libraryStatusReads++; return api<ToolValidationLibrary>('/__validation/library'); };
  const status = (id: string, taskId: string) => { observations.conversationStatusReads++;
    return api<ToolValidationConversation>(`/__validation/conversations/${id}/status?taskId=${taskId}`); };
  const snapshot = (id: string) => { observations.publicSnapshotReads++; return api<Snapshot>(`/conversations/${id}`); };
  async function clean(id: string, taskId: string) {
    let value: ToolValidationConversation | undefined;
    await until(async () => { value = await status(id, taskId); return Boolean(value.task && value.task.status !== 'active' && value.workflowStatus === 'complete'
      && value.privateStreams + value.privatePayloads + value.retainedContexts + value.pendingNotifications + value.pendingSearch === 0 && value.alarmAt === null); }, 'Natural terminal cleanup', 45_000, 2000);
    assert.ok(value); return value;
  }
  async function idleLibrary() {
    let value: ToolValidationLibrary | undefined;
    await until(async () => { value = await library(); return value.pendingBackfills === 0 && value.alarmAt === null; }, 'Library idle', 30_000, 2000);
    assert.ok(value); return value;
  }
  const providers = protocols.map((provider) => ({ id: crypto.randomUUID(), name: provider, provider, baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
    models: [`tools-service-${provider}`, `tools-loop-${provider}`, `tools-service-large-${provider}`, `tools-service-sustained-${provider}`]
      .map((id) => ({ id, name: id, enabled: true, reasoningSupport: 'supported', metadataOverrides: { toolCalls: true, contextWindow: 131072 } })) }));
  async function prepare(name: string, protocol: ProviderKind, model: string, mode: 'service' | 'service-401' = 'service', disconnect = false) {
    const id = crypto.randomUUID(), taskId = crypto.randomUUID(), begin = Date.now();
    await api('/conversations', { id, title: name });
    await api(`/__validation/conversations/${id}/prepare`, { mode });
    const live = await subscriber(id, disconnect);
    const input = { parentId: null, requestId: taskId, content: 'Deterministic isolated web tool validation', selection: { providerId: providers.find((p) => p.provider === protocol)!.id, model }, showReasoning: true, tools: ['web_search', 'read_webpage'] };
    return { id, taskId, begin, live, input };
  }
  async function submit(item: Awaited<ReturnType<typeof prepare>>) {
    const accepted = await api<Submission>(`/conversations/${item.id}/messages`, item.input);
    assert.deepEqual(await api(`/conversations/${item.id}/messages`, item.input), accepted, 'Duplicate acceptance'); return accepted;
  }
  async function finish(item: Awaited<ReturnType<typeof prepare>>, disconnected = false) {
    if (disconnected) await until(async () => terminal(await snapshot(item.id)), 'Offline completion', 180_000, 5000);
    else await until(() => { item.live.check(); assert.ok(!item.live.closed(), 'Unexpected subscription close'); return terminal(item.live.sync.durable); }, 'Online completion', 180_000);
    const stored = await snapshot(item.id);
    if (!disconnected) assert.deepEqual(item.live.sync.durable, stored, 'Public stream must match saved result');
    else {
      assert.ok(item.live.observed.disconnected); await until(item.live.closed, 'Disconnected subscriber close');
      const replay = await subscriber(item.id);
      await until(() => { replay.check(); return replay.sync.durable.seq >= stored.seq; }, 'Terminal replay');
      assert.deepEqual(replay.sync.durable, stored); replay.socket.close(1000);
    }
    item.live.socket.close(1000);
    const serialized = JSON.stringify(stored);
    for (const secret of ['integration-test-key', 'tvly-isolated-fixture-key', 'fixture-signature', 'encrypted-fixture'])
      assert.ok(!serialized.includes(secret), 'Public state must exclude private credentials/continuation data');
    const runtime = await clean(item.id, item.taskId), answer = stored.messages[1];
    return { conversationId: item.id, taskId: item.taskId, status: answer.status, contentCharacters: messageText(answer).length,
      reasoningCharacters: messageText(answer, 'reasoning').length, elapsedMs: Date.now() - item.begin, runtime, client: item.live.observed };
  }
  try {
    // Check identity before sending a password or changing ANY configuration.
    identity = await api<ToolValidationIdentity>('/__validation/identity');
    assert.equal(identity.kind, TOOL_VALIDATION_WORKER); assert.equal(identity.version, 1); assert.equal(identity.runId, options.runId, 'Different runtime; refusing to log in');
    assert.equal(identity.mockUpstreams, true); assert.deepEqual(identity.counters, { generation: false, local: false });
    assert.deepEqual(identity.workload, { chunks: 120, size: 200, interval: 25 });
    assert.equal((await request('/__validation/library')).status, 401);
    assert.equal((await request('/__test/resources/library', {})).status, 404);
    await api('/login', { password: options.password });
    assert.equal((await request('/__validation/conversations/' + crypto.randomUUID() + '/prepare', { mode: 'service' }, 'POST', { Origin: 'https://untrusted.test' })).status, 403);
    assert.equal((await request(`/conversations/${crypto.randomUUID()}/measurements`)).status, 404);
    await api('/settings/providers', { providers, activeProviderId: providers[0].id, activeModel: providers[0].models[0].id, systemPrompt: '', showReasoning: true, maxOutputTokens: null }, 'PUT');
    await api('/settings/web-tools', { provider: 'tavily', apiKey: 'tvly-isolated-fixture-key', dailyLimit: 1000 }, 'PUT');
    const cases = options.suite === 'functional' ? [
      ...protocols.map((protocol) => ({ name: `online-${protocol}`, protocol, mode: 'success' })),
      { name: 'disconnected-replay', protocol: 'openai-chat' as const, mode: 'disconnect' },
      { name: 'round-limit', protocol: 'openai-chat' as const, mode: 'loop' },
      { name: 'service-rejected', protocol: 'openai-chat' as const, mode: 'rejected' },
      { name: 'cancel-model', protocol: 'openai-chat' as const, mode: 'cancel' },
    ] : [{ name: `responses-${options.suite}`, protocol: 'openai-responses' as const, mode: options.suite }];
    for (const entry of cases) {
      const before = await idleLibrary();
      const variant = entry.mode === 'large' ? 'large-' : entry.mode === 'sustained' || entry.mode === 'cancel' ? 'sustained-' : '';
      const item = await prepare(entry.name, entry.protocol, `tools-${entry.mode === 'loop' ? 'loop' : 'service'}-${variant}${entry.protocol}`, entry.mode === 'rejected' ? 'service-401' : 'service', entry.mode === 'disconnect');
      const accepted = await submit(item);
      if (entry.mode === 'cancel') {
        await until(() => { item.live.check(); return messageText(item.live.sync.view.messages[1]).length > 0; }, 'First preview before cancellation');
        await api(`/conversations/${item.id}/cancel`, { runId: accepted.runId });
      }
      const result = await finish(item, entry.mode === 'disconnect');
      const after = await idleLibrary(), failed = entry.mode === 'loop' || entry.mode === 'rejected', cancelled = entry.mode === 'cancel';
      const expectedModels = entry.mode === 'loop' ? 4 : failed || cancelled ? 1 : 2;
      const expectedTools = entry.mode === 'loop' ? 6 : entry.mode === 'rejected' ? 1 : cancelled ? 0 : 2;
      assert.equal(result.status, cancelled ? 'cancelled' : failed ? 'failed' : 'completed');
      assert.equal(result.runtime.modelCalls, expectedModels); assert.equal(result.runtime.task!.modelRequests, expectedModels);
      assert.equal(result.runtime.serviceRequests, expectedTools); assert.equal(after.usedToday - before.usedToday, expectedTools);
      assert.equal(result.runtime.task!.toolRequests, expectedTools);
      if (!failed && !cancelled) {
        const size = entry.mode === 'large' ? 750 : 200;
        const expected = (entry.protocol === 'openai-chat' ? '先查阅资料。\n' : '') + ('x'.repeat(size - 2) + '🙂').repeat(120);
        assert.equal(messageText((await snapshot(item.id)).messages[1]), expected, 'Complete generated content');
      }
      if (entry.mode === 'sustained') assert.ok(result.elapsedMs >= 60_000, 'Sustained run must exceed a minute');
      results.push({ scenario: entry.name, protocol: entry.protocol, ...result, library: { ...after, usedInWindow: after.usedToday - before.usedToday } });
      console.log(JSON.stringify({ scenario: entry.name, status: result.status, modelCalls: result.runtime.modelCalls, serviceRequests: result.runtime.serviceRequests, elapsedMs: result.elapsedMs }));
    }
    if (options.suite === 'functional') {
      const before = await idleLibrary();
      await api('/settings/web-tools', { provider: 'tavily', dailyLimit: before.usedToday + 1 }, 'PUT');
      try {
        const items = await Promise.all([0, 1].map((i) => prepare(`shared-quota-${i}`, 'openai-chat', 'tools-service-openai-chat')));
        await Promise.all(items.map(submit));
        const answers = await Promise.all(items.map((item) => finish(item))), after = await idleLibrary();
        assert.ok(answers.every((answer) => answer.status === 'failed' && answer.runtime.modelCalls === 1 && answer.runtime.task!.modelRequests === 1));
        assert.equal(answers.reduce((sum, answer) => sum + answer.runtime.serviceRequests, 0), 1, 'One actual HTTP attempt across concurrent tasks');
        assert.equal(after.usedToday - before.usedToday, 1);
        results.push({ scenario: 'concurrent-shared-quota', tasks: answers, library: { ...after, usedInWindow: 1 } });
        console.log(JSON.stringify({ scenario: 'concurrent-shared-quota', modelCalls: 2, serviceRequests: 1 }));
      } finally { await api('/settings/web-tools', { provider: 'tavily', dailyLimit: 1000 }, 'PUT'); }
    }
    assert.equal(results.length, options.suite === 'functional' ? 9 : 1); complete = true;
  } finally {
    for (const socket of sockets) socket.terminate(); agent?.destroy();
    const output = resolve(options.output); await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ version: 1, runtime: options.runtime, workerName: TOOL_VALIDATION_WORKER, suite: options.suite, startedAt,
      finishedAt: new Date().toISOString(), complete, expectedScenarios: options.suite === 'functional' ? 9 : 1, identity, observations,
      observationPolicy: { activeLibraryProbes: false, offlineSnapshotIntervalMs: 5000, terminalStatusIntervalMs: 2000 },
      scope: 'All diagnostic counters disabled. Native tool Workflow and production service adapter with isolated mock HTTP; no paid supplier calls. Public WebSocket completion before read-only terminal checks. API setup, fixture bookkeeping SQL and observation requests are part of the reported platform window. Local elapsed time/SQLite allocation are not CPU, billed resources, natural hibernation proof or account totals.', results }, null, 2) + '\n');
  }
  return { complete, scenarios: results.length };
}
