import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { applyChange, type ProviderSettings, type Snapshot, type SyncPacket } from '../../shared/types';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };

async function subscribe(request: APIRequestContext, id: string, protocol: number, initial: Snapshot = { messages: [], seq: 0 }) {
  const { cookies } = await request.storageState();
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=${initial.seq}&protocol=${protocol}`,
    { headers: { ...headers, Cookie: cookie } });
  const packets: SyncPacket[] = [];
  let snapshot = initial, failure: Error | undefined;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscriber readiness timeout')), 10_000);
    socket.on('error', (error) => { clearTimeout(timer); failure = error; reject(error); });
    socket.on('message', (data) => {
      try {
        const packet = JSON.parse(data.toString()) as SyncPacket;
        packets.push(packet);
        if (packet.type === 'snapshot') snapshot = packet.snapshot;
        if (packet.type === 'change' || packet.type === 'append') snapshot = applyChange(snapshot, packet);
        if (packet.type === 'ready') { expect(packet.seq).toBe(snapshot.seq); clearTimeout(timer); resolve(); }
      } catch (error) { failure = error as Error; clearTimeout(timer); reject(error); }
    });
  });
  return { socket, packets, snapshot: () => { if (failure) throw failure; return snapshot; } };
}

test('incremental subscribers resume from their offset and agree with legacy subscribers and durable snapshots', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const sockets: WebSocket[] = [];
  try {
    const providerId = crypto.randomUUID(), id = crypto.randomUUID();
    expect((await request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Journal test', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-reasoning-40-100-200', name: 'Replay fixture', enabled: true, reasoningSupport: 'supported' }] }],
      activeProviderId: providerId, activeModel: 'benchmark-reasoning-40-100-200', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).ok()).toBe(true);
    expect((await request.post('/api/conversations', { headers, data: { id, title: 'Incremental replay' } })).status()).toBe(201);
    const first = await subscribe(request, id, 2), legacy = await subscribe(request, id, 1);
    sockets.push(first.socket, legacy.socket);
    const submission = await request.post(`/api/conversations/${id}/messages`, { headers, data: {
      requestId: crypto.randomUUID(), content: '保存正文和思考', showReasoning: true,
    } }).then((response) => response.json());
    const answer = (snapshot: Snapshot) => snapshot.messages.find((message) => message.runId === submission.runId && message.role === 'assistant');
    await expect.poll(() => answer(first.snapshot())?.content.length ?? 0).toBeGreaterThan(1000);
    expect(first.packets.some((packet) => packet.type === 'append' && packet.reasoning.length > 0)).toBe(true);
    const prefix = first.snapshot();
    first.socket.terminate();
    const resumed = await subscribe(request, id, 2, prefix);
    sockets.push(resumed.socket);
    await expect.poll(() => answer(resumed.snapshot())?.status).toBe('completed');
    const stored = await request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    await expect.poll(() => legacy.snapshot()).toEqual(stored);
    expect(resumed.snapshot()).toEqual(stored);
    expect(answer(stored)).toMatchObject({ content: '正文🙂'.repeat(2000), reasoning: '思考🙂'.repeat(2000), streamVersion: 'semantic-delta-v1' });
    expect(answer(stored)!.durableOffset).toBeGreaterThan(0);
    expect(resumed.packets.some((packet) => packet.type === 'append')).toBe(true);
    expect(legacy.packets.every((packet) => packet.type !== 'append')).toBe(true);
    const afterFinal = await subscribe(request, id, 2, stored);
    sockets.push(afterFinal.socket);
    expect(afterFinal.snapshot()).toEqual(stored);
    expect(afterFinal.packets).toEqual([{ type: 'ready', seq: stored.seq }]);
  } finally {
    for (const socket of sockets) socket.terminate();
    expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});

test('premature upstream EOF saves buffered text and thoughts, marks failure and preserves submission idempotency', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  let socket: WebSocket | undefined;
  try {
    const providerId = crypto.randomUUID(), id = crypto.randomUUID();
    expect((await request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Interrupted fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-error-8-25-200', name: 'Early EOF', enabled: true, reasoningSupport: 'supported' }] }],
      activeProviderId: providerId, activeModel: 'benchmark-error-8-25-200', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).ok()).toBe(true);
    expect((await request.post('/api/conversations', { headers, data: { id, title: 'Early EOF' } })).status()).toBe(201);
    const live = await subscribe(request, id, 2); socket = live.socket;
    const input = { requestId: crypto.randomUUID(), content: '保留未完成回答', showReasoning: true };
    const accepted = await request.post(`/api/conversations/${id}/messages`, { headers, data: input }).then((response) => response.json());
    await expect.poll(() => live.snapshot().messages.find((message) => message.runId === accepted.runId)?.status).toBe('failed');
    const stored = await request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    expect(live.snapshot()).toEqual(stored);
    expect(stored.messages[1]).toMatchObject({ content: '正文🙂'.repeat(400), reasoning: '思考🙂'.repeat(400), status: 'failed' });
    expect(stored.messages[1].error).toBeTruthy();
    const repeated = await request.post(`/api/conversations/${id}/messages`, { headers, data: input });
    expect(repeated.status()).toBe(202); expect(await repeated.json()).toEqual(accepted);
    expect(await request.get(`/api/conversations/${id}`).then((response) => response.json())).toEqual(stored);
  } finally {
    socket?.terminate();
    expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});
