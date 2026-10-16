import { messageText } from '../../shared/conversation/content';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';
import { Agent } from 'node:https';
import type { ModelSelection } from '../../shared/models/types';
import type { ProviderKind } from '../../shared/providers/types';
import type { Snapshot, SyncPacket } from '../../shared/streaming/protocol';
import type { Submission } from '../../shared/conversation/types';
import { StreamSync } from '../../shared/streaming/sync';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, credentials: { type: 'string' }, output: { type: 'string', default: '/tmp/everchat-stream-cloudflare.json' },
  suite: { type: 'string', default: 'functional' },
  source: { type: 'string' },
} });
assert.ok(['functional', 'sustained', 'reconnect'].includes(values.suite!), '--suite must be functional, sustained or reconnect');
const sustained = values.suite === 'sustained';
const reconnect = values.suite === 'reconnect';
const expectedScenarios = reconnect ? 30 : sustained ? 3 : 9;
assert.ok(values.url && values.credentials, '--url and --credentials are required');
const url = new URL(values.url);
assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.startsWith('everchat-stream-validation.') && url.hostname.endsWith('.workers.dev'), 'Use only the isolated validation Worker');
const origin = url.origin;
const { APP_PASSWORD } = JSON.parse(await readFile(values.credentials, 'utf8')) as { APP_PASSWORD: string };
assert.ok(APP_PASSWORD?.length >= 32, 'A random validation password is required');
let cookie = '';
const sockets = new Set<WebSocket>();
// ws overrides the default connector; supply an explicit agent to honor configured proxies.
const agent = new Agent({ proxyEnv: process.env });
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, Cookie: cookie,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  if (path === '/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<T>;
}
async function subscriber(id: string, initial: Snapshot = { messages: [], seq: 0 }, acknowledge = true) {
  const socket = new WebSocket(`${origin.replace('https:', 'wss:')}/api/conversations/${id}/sync?after=${initial.seq}`, { agent, handshakeTimeout: 30000, headers: { Cookie: cookie, Origin: origin } });
  sockets.add(socket);
  const sync = new StreamSync(initial), received = { frames: 0, bytes: 0 };
  let failure: Error | undefined, code: number | undefined;
  socket.on('close', (value) => { code = value; sockets.delete(socket); });
  try { await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscription timed out')), 30000);
    socket.on('error', (error) => { failure = error; clearTimeout(timer); reject(error); });
    socket.on('message', (value) => {
      received.frames++; received.bytes += Buffer.byteLength(value.toString());
      try {
        const packet = JSON.parse(value.toString()) as SyncPacket;
        sync.receive(packet);
        if (packet.type === 'preview' && acknowledge) socket.send(JSON.stringify({ type: 'preview-ack', runId: packet.batch.runId, messageId: packet.batch.messageId, offset: packet.batch.endOffset }));
        if (packet.type === 'ready') { clearTimeout(timer); ready(); }
      } catch (error) { failure = error as Error; clearTimeout(timer); reject(error); }
    });
  }); } catch (error) { socket.terminate(); throw error; }
  return { socket, sync, received, check: () => { if (failure) throw failure; }, code: () => code };
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 30000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, `${label}: timed out`); await pause(interval); }
}
const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
try {
  assert.equal((await fetch(`${origin}/api/settings/providers`)).status, 401);
  await api('/login', { password: APP_PASSWORD });
  assert.equal((await fetch(`${origin}/api/conversations/${crypto.randomUUID()}/measurements`, { headers: { Cookie: cookie } })).status, 404, 'Disable diagnostic CPU overhead for platform measurement');
  if (reconnect) {
    assert.ok(values.source, '--source requires a completed sustained report');
    const source = JSON.parse(await readFile(values.source, 'utf8')) as { workerName: string; complete: boolean; results: { conversationId: string; contentCharacters: number; reasoningCharacters: number }[] };
    assert.equal(source.workerName, 'everchat-stream-validation'); assert.equal(source.complete, true);
    const item = source.results.find((result) => result.reasoningCharacters > 0); assert.ok(item);
    const stored = await api<Snapshot>(`/conversations/${item.conversationId}`);
    assert.equal(stored.messages[1].status, 'completed');
    assert.equal(messageText(stored.messages[1]).length, item.contentCharacters); assert.equal(messageText(stored.messages[1], 'reasoning').length, item.reasoningCharacters);
    for (let index = 0; index < expectedScenarios; index++) {
      let live: Awaited<ReturnType<typeof subscriber>> | undefined, handshakeAttempts = 0;
      while (!live) {
        handshakeAttempts++;
        try { live = await subscriber(item.conversationId, index % 2 ? stored : undefined); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (handshakeAttempts >= 3 || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code ?? '')) throw error;
          await pause(handshakeAttempts * 1000);
        }
      }
      live.check(); assert.deepEqual(live.sync.durable, stored);
      live.socket.close(1000); await until(() => live.code() !== undefined, 'clean replay close'); assert.equal(live.code(), 1000);
      results.push({ scenario: `reconnect-${index + 1}`, mode: index % 2 ? 'latest-cursor' : 'full-replay', status: 'completed', handshakeAttempts, client: live.received });
    }
    console.log(JSON.stringify({ suite: 'reconnect', completed: results.length }));
  } else {
    const profiles = (['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map((provider) => ({ id: crypto.randomUUID(), name: provider, provider,
      baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [
        { id: `raw-${provider}`, name: 'Raw SSE', enabled: true, reasoningSupport: 'supported' },
        ...(provider === 'openai-chat' ? ['benchmark-text-120-25-200', 'benchmark-reasoning-120-25-200', 'benchmark-long-120-25-750',
          'benchmark-reasoning-120-25-750', 'benchmark-text-120-100-200', 'benchmark-text-140-500-600', 'benchmark-reasoning-140-500-600'].map((id) => ({ id, name: id, enabled: true, reasoningSupport: 'supported' })) : []),
      ] }));
    await api('/settings/providers', { providers: profiles, activeProviderId: profiles[0].id, activeModel: profiles[0].models[0].id,
      systemPrompt: '', showReasoning: true, maxOutputTokens: null }, 'PUT');
    const cases: { name: string; protocol: ProviderKind; model: string; mode?: 'disconnect' | 'cancel' | 'partial' | 'slow' | 'reconnect'; characters: number; thoughts: number }[] = sustained ? [
      { name: 'sustained-text', protocol: 'openai-chat', model: 'benchmark-text-140-500-600', characters: 84000, thoughts: 0 },
      { name: 'sustained-reasoning-reconnect', protocol: 'openai-chat', model: 'benchmark-reasoning-140-500-600', mode: 'reconnect', characters: 84000, thoughts: 84000 },
      { name: 'sustained-disconnected', protocol: 'openai-chat', model: 'benchmark-text-140-500-600', mode: 'disconnect', characters: 84000, thoughts: 0 },
    ] : [
      { name: 'online-text', protocol: 'openai-chat', model: 'benchmark-text-120-25-200', characters: 24000, thoughts: 0 },
      { name: 'online-reasoning', protocol: 'openai-chat', model: 'benchmark-reasoning-120-25-200', characters: 24000, thoughts: 24000 },
      { name: 'disconnected-long', protocol: 'openai-chat', model: 'benchmark-long-120-25-750', mode: 'disconnect', characters: 90000, thoughts: 0 },
      ...(['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map((protocol) => ({ name: `${protocol}-partial-resume`, protocol,
        model: `raw-${protocol}`, mode: 'partial' as const, characters: '**正文🙂**\n答案。'.length, thoughts: '**思考🙂**\n结论。'.length })),
      { name: 'slow-subscriber', protocol: 'openai-chat', model: 'benchmark-reasoning-120-25-750', mode: 'slow', characters: 90000, thoughts: 90000 },
      { name: 'cancel', protocol: 'openai-chat', model: 'benchmark-text-120-100-200', mode: 'cancel', characters: 0, thoughts: 0 },
    ];
    for (const item of cases) {
      const id = crypto.randomUUID(), begin = Date.now();
      await api('/conversations', { id, title: item.name });
      let live = await subscriber(id);
      const earlierClient = { frames: 0, bytes: 0 };
      const shadow = item.name.includes('reasoning') ? await subscriber(id) : undefined;
      const slow = item.mode === 'slow' ? await subscriber(id, undefined, false) : undefined;
      const selection: ModelSelection = { providerId: profiles.find((profile) => profile.provider === item.protocol)!.id, model: item.model };
      const input = { parentId: null, requestId: crypto.randomUUID(), content: sustained ? '长输入。'.repeat(4000) : 'Platform stream validation', selection, showReasoning: true };
      const accepted = await api<Submission>(`/conversations/${id}/messages`, input);
      assert.deepEqual(await api(`/conversations/${id}/messages`, input), accepted);
      const acceptedAt = Date.now();
      let reconnects = 0;
      if (item.mode === 'partial') {
        await until(() => { live.check(); return (live.sync.durable.messages[1]?.durableOffset ?? 0) > 0; }, item.name);
        assert.ok(live.sync.durable.messages[1].streamState?.utf8);
        live.socket.close();
        const snapshot = await api<Snapshot>(`/conversations/${id}`);
        assert.ok(snapshot.messages[1].streamState?.utf8);
        earlierClient.frames += live.received.frames; earlierClient.bytes += live.received.bytes;
        live = await subscriber(id, snapshot);
      } else if (item.mode === 'reconnect') {
        for (let index = 0; index < 20; index++) {
          await pause(1500);
          live.check(); live.socket.close();
          await until(() => live.code() !== undefined, 'close before reconnect');
          const snapshot = await api<Snapshot>(`/conversations/${id}`);
          earlierClient.frames += live.received.frames; earlierClient.bytes += live.received.bytes;
          live = await subscriber(id, snapshot); reconnects++;
          assert.ok(live.sync.durable.seq >= snapshot.seq);
          assert.equal(live.sync.view.messages[1]?.runId, accepted.runId);
        }
      } else if (item.mode === 'disconnect' || item.mode === 'cancel') {
        await until(() => { live.check(); return (messageText(live.sync.view.messages[1]).length) > 0; }, item.name);
        if (item.mode === 'disconnect') live.socket.close();
        else await api(`/conversations/${id}/cancel`, { runId: accepted.runId });
      }
      let stored: Snapshot;
      if (item.mode === 'disconnect') {
        await until(async () => { stored = await api<Snapshot>(`/conversations/${id}`); return ['completed', 'failed'].includes(stored.messages[1].status); }, item.name, sustained ? 150000 : 30000, sustained ? 5000 : 100);
      } else {
        await until(() => { live.check(); return ['completed', 'failed', 'cancelled'].includes(live.sync.durable.messages[1]?.status ?? ''); }, item.name, sustained ? 150000 : 30000);
      }
      stored = await api<Snapshot>(`/conversations/${id}`);
      const answer = stored.messages[1];
      const generationElapsedMs = Date.now() - acceptedAt;
      if (sustained) assert.ok(generationElapsedMs >= 60000, `${item.name}: exercise at least one minute of generation`);
      assert.equal(answer.status, item.mode === 'cancel' ? 'cancelled' : 'completed', `${item.name}: ${answer.error}`);
      if (item.mode === 'cancel') assert.ok(messageText(answer).length > 0 && messageText(answer).length < 24000);
      else { assert.equal(messageText(answer).length, item.characters); assert.equal(messageText(answer, 'reasoning').length, item.thoughts); }
      if (item.mode !== 'disconnect') assert.deepEqual(live.sync.durable, stored);
      if (shadow) { await until(() => shadow.sync.durable.seq === stored.seq, 'second device'); shadow.check(); assert.deepEqual(shadow.sync.durable, stored); shadow.socket.close(); }
      if (slow) { await until(() => slow.code() === 4002, 'bounded slow subscriber'); slow.check(); const recovered = await subscriber(id, slow.sync.durable);
        assert.deepEqual(recovered.sync.durable, stored); recovered.socket.close(); }
      const replay = await subscriber(id); assert.deepEqual(replay.sync.durable, stored); replay.socket.close(); live.socket.close();
      results.push({ scenario: item.name, conversationId: id, status: answer.status, contentCharacters: messageText(answer).length, reasoningCharacters: messageText(answer, 'reasoning').length,
        elapsedMs: Date.now() - begin, generationElapsedMs, reconnects,
        client: { frames: earlierClient.frames + live.received.frames, bytes: earlierClient.bytes + live.received.bytes } });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  for (const socket of sockets) socket.terminate();
  agent.destroy();
  const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, runtime: 'deployed Cloudflare isolated fixture', workerName: 'everchat-stream-validation',
    plan: 'Workers Free (user confirmed)', suite: values.suite, diagnosticCounters: false, expectedScenarios, complete: results.length === expectedScenarios, startedAt, finishedAt: new Date().toISOString(), results,
    scope: 'Functional cases with mock suppliers; platform analytics collected separately. No real model calls or production data.' }, null, 2) + '\n');
}
