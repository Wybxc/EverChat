import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';
import { Agent } from 'node:https';
import type { ModelSelection, ProviderKind, Snapshot, Submission, SyncPacket } from '../shared/types';
import { StreamSync } from '../shared/stream-sync';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, credentials: { type: 'string' }, output: { type: 'string', default: '/tmp/everchat-stream-cloudflare.json' },
} });
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
  await new Promise<void>((ready, reject) => {
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
  });
  return { socket, sync, received, check: () => { if (failure) throw failure; }, code: () => code };
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, `${label}: timed out`); await pause(100); }
}
const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
try {
  assert.equal((await fetch(`${origin}/api/settings/providers`)).status, 401);
  await api('/login', { password: APP_PASSWORD });
  assert.equal((await fetch(`${origin}/api/conversations/${crypto.randomUUID()}/measurements`, { headers: { Cookie: cookie } })).status, 404, 'Disable diagnostic CPU overhead for platform measurement');
  const profiles = (['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map((provider) => ({ id: crypto.randomUUID(), name: provider, provider,
    baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [
      { id: `raw-${provider}`, name: 'Raw SSE', enabled: true, reasoningSupport: 'supported' },
      ...(provider === 'openai-chat' ? ['benchmark-text-120-25-200', 'benchmark-reasoning-120-25-200', 'benchmark-long-120-25-750',
        'benchmark-reasoning-120-25-750', 'benchmark-text-120-100-200'].map((id) => ({ id, name: id, enabled: true, reasoningSupport: 'supported' })) : []),
    ] }));
  await api('/settings/providers', { providers: profiles, activeProviderId: profiles[0].id, activeModel: profiles[0].models[0].id,
    systemPrompt: '', showReasoning: true, maxOutputTokens: null }, 'PUT');
  const cases: { name: string; protocol: ProviderKind; model: string; mode?: 'disconnect' | 'cancel' | 'partial' | 'slow'; characters: number; thoughts: number }[] = [
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
    const shadow = item.name === 'online-reasoning' ? await subscriber(id) : undefined;
    const slow = item.mode === 'slow' ? await subscriber(id, undefined, false) : undefined;
    const selection: ModelSelection = { providerId: profiles.find((profile) => profile.provider === item.protocol)!.id, model: item.model };
    const input = { requestId: crypto.randomUUID(), content: 'Platform stream validation', selection, showReasoning: true };
    const accepted = await api<Submission>(`/conversations/${id}/messages`, input);
    assert.deepEqual(await api(`/conversations/${id}/messages`, input), accepted);
    if (item.mode === 'partial') {
      await until(() => { live.check(); return (live.sync.durable.messages[1]?.durableOffset ?? 0) > 0; }, item.name);
      assert.ok(live.sync.durable.messages[1].streamState?.utf8);
      live.socket.close();
      const snapshot = await api<Snapshot>(`/conversations/${id}`);
      assert.ok(snapshot.messages[1].streamState?.utf8);
      live = await subscriber(id, snapshot);
    } else if (item.mode === 'disconnect' || item.mode === 'cancel') {
      await until(() => { live.check(); return (live.sync.view.messages[1]?.content.length ?? 0) > 0; }, item.name);
      if (item.mode === 'disconnect') live.socket.close();
      else await api(`/conversations/${id}/cancel`, { runId: accepted.runId });
    }
    let stored: Snapshot;
    if (item.mode === 'disconnect') {
      await until(async () => { stored = await api<Snapshot>(`/conversations/${id}`); return ['completed', 'failed'].includes(stored.messages[1].status); }, item.name);
    } else {
      await until(() => { live.check(); return ['completed', 'failed', 'cancelled'].includes(live.sync.durable.messages[1]?.status ?? ''); }, item.name);
    }
    stored = await api<Snapshot>(`/conversations/${id}`);
    const answer = stored.messages[1];
    assert.equal(answer.status, item.mode === 'cancel' ? 'cancelled' : 'completed', `${item.name}: ${answer.error}`);
    if (item.mode === 'cancel') assert.ok(answer.content.length > 0 && answer.content.length < 24000);
    else { assert.equal(answer.content.length, item.characters); assert.equal(answer.reasoning?.length ?? 0, item.thoughts); }
    if (item.mode !== 'disconnect') assert.deepEqual(live.sync.durable, stored);
    if (shadow) { await until(() => shadow.sync.durable.seq === stored.seq, 'second device'); shadow.check(); assert.deepEqual(shadow.sync.durable, stored); shadow.socket.close(); }
    if (slow) { await until(() => slow.code() === 4002, 'bounded slow subscriber'); slow.check(); const recovered = await subscriber(id, slow.sync.durable);
      assert.deepEqual(recovered.sync.durable, stored); recovered.socket.close(); }
    const replay = await subscriber(id); assert.deepEqual(replay.sync.durable, stored); replay.socket.close(); live.socket.close();
    results.push({ scenario: item.name, conversationId: id, status: answer.status, contentCharacters: answer.content.length, reasoningCharacters: answer.reasoning?.length ?? 0,
      elapsedMs: Date.now() - begin, client: live.received });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  for (const socket of sockets) socket.terminate();
  agent.destroy();
  const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, runtime: 'deployed Cloudflare isolated fixture', workerName: 'everchat-stream-validation',
    plan: 'Workers Free (user confirmed)', diagnosticCounters: false, expectedScenarios: 9, complete: results.length === 9, startedAt, finishedAt: new Date().toISOString(), results,
    scope: 'Functional cases with mock suppliers; platform analytics collected separately. No real model calls or production data.' }, null, 2) + '\n');
}
