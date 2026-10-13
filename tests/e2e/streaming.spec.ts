import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { type ProviderSettings, type Snapshot, type SyncPacket } from '../../shared/types';
import { StreamSync } from '../../shared/stream-sync';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };

async function subscribe(request: APIRequestContext, id: string, initial: Snapshot = { messages: [], seq: 0 }, acknowledge = true) {
  const { cookies } = await request.storageState();
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=${initial.seq}`,
    { headers: { ...headers, Cookie: cookie } });
  const packets: SyncPacket[] = [];
  const sync = new StreamSync(initial);
  let failure: Error | undefined, closeCode: number | undefined;
  socket.on('close', (code) => { closeCode = code; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscriber readiness timeout')), 10_000);
    socket.on('error', (error) => { clearTimeout(timer); failure = error; reject(error); });
    socket.on('message', (data) => {
      try {
        const packet = JSON.parse(data.toString()) as SyncPacket;
        packets.push(packet);
        sync.receive(packet);
        if (packet.type === 'preview' && acknowledge) socket.send(JSON.stringify({ type: 'preview-ack', runId: packet.batch.runId, messageId: packet.batch.messageId, offset: packet.batch.endOffset }));
        if (packet.type === 'ready') { clearTimeout(timer); resolve(); }
      } catch (error) { failure = error as Error; clearTimeout(timer); reject(error); }
    });
  });
  return { socket, packets, snapshot: () => { if (failure) throw failure; return sync.durable; }, view: () => { if (failure) throw failure; return sync.view; }, closeCode: () => closeCode };
}

test('previews precede commits and reconnecting subscribers recover the same durable and live boundaries', async ({ request }) => {
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
    const first = await subscribe(request, id), second = await subscribe(request, id);
    sockets.push(first.socket, second.socket);
    const submission = await request.post(`/api/conversations/${id}/messages`, { headers, data: {
      requestId: crypto.randomUUID(), content: '保存正文和思考', showReasoning: true,
    } }).then((response) => response.json());
    const answer = (snapshot: Snapshot) => snapshot.messages.find((message) => message.runId === submission.runId && message.role === 'assistant');
    await expect.poll(() => answer(first.view())?.content.length ?? 0).toBeGreaterThan(0);
    expect(first.packets.some((packet) => packet.type === 'preview' && packet.batch.reasoning.length > 0)).toBe(true);
    expect(answer(first.snapshot())!.content).toBe('');
    expect((await request.get(`/api/conversations/${id}`).then((response) => response.json())).messages[1].content).toBe('');
    const prefix = first.snapshot();
    first.socket.terminate();
    const resumed = await subscribe(request, id, prefix);
    sockets.push(resumed.socket);
    await expect.poll(() => answer(resumed.snapshot())?.status).toBe('completed');
    const stored = await request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    await expect.poll(() => second.snapshot()).toEqual(stored);
    expect(resumed.snapshot()).toEqual(stored);
    expect(answer(stored)).toMatchObject({ content: '正文🙂'.repeat(2000), reasoning: '思考🙂'.repeat(2000), streamVersion: 'semantic-delta-v1' });
    expect(answer(stored)!.durableOffset).toBeGreaterThan(0);
    expect(resumed.packets.some((packet) => packet.type === 'commit-ack')).toBe(true);
    expect(resumed.packets.some((packet) => packet.type === 'preview')).toBe(true);
    const afterFinal = await subscribe(request, id, stored);
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
    const live = await subscribe(request, id); socket = live.socket;
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


test('an unacknowledged slow subscriber is bounded while other clients and persistence complete', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const sockets: WebSocket[] = [];
  try {
    const providerId = crypto.randomUUID(), id = crypto.randomUUID();
    expect((await request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Slow subscriber', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-reasoning-120-10-750', name: 'Bounded window', enabled: true, reasoningSupport: 'supported' }] }],
      activeProviderId: providerId, activeModel: 'benchmark-reasoning-120-10-750', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).ok()).toBe(true);
    expect((await request.post('/api/conversations', { headers, data: { id, title: 'Slow subscriber' } })).status()).toBe(201);
    const slow = await subscribe(request, id, { messages: [], seq: 0 }, false), live = await subscribe(request, id);
    sockets.push(slow.socket, live.socket);
    expect((await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '有界订阅', showReasoning: true } })).status()).toBe(202);
    await expect.poll(() => slow.closeCode()).toBe(4002);
    await expect.poll(() => live.snapshot().messages[1]?.status).toBe('completed');
    const stored = await request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    expect(live.snapshot()).toEqual(stored);
    expect(stored.messages[1].content.length).toBe(90000); expect(stored.messages[1].reasoning!.length).toBe(90000);
    const received = slow.packets.filter((packet) => packet.type === 'preview').map((packet) => packet.batch);
    expect(received.at(-1)!.endOffset).toBeLessThanOrEqual(128 * 1024);
    const recovered = await subscribe(request, id, slow.snapshot()); sockets.push(recovered.socket);
    expect(recovered.snapshot()).toEqual(stored);
  } finally {
    for (const socket of sockets) socket.terminate();
    expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});


test('browser rendering streams ahead of saving, while export and throttled cache contain only durable output', async ({ page, context }) => {
  expect((await context.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await context.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  try {
    const providerId = crypto.randomUUID();
    expect((await context.request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Browser preview', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-reasoning-40-100-200', name: 'Preview', enabled: true, reasoningSupport: 'supported' }] }],
      activeProviderId: providerId, activeModel: 'benchmark-reasoning-40-100-200', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).ok()).toBe(true);
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      (window as unknown as { snapshotWrites: unknown[] }).snapshotWrites = [];
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('everchat:snapshot:')) (window as unknown as { snapshotWrites: unknown[] }).snapshotWrites.push(JSON.parse(value));
        return original.call(this, key, value);
      };
    });
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('验证持久化导出');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const answer = page.getByTestId('assistant-message');
    await expect(answer).toContainText('正文');
    await expect(answer).toHaveAttribute('data-durable-offset', '0');
    await expect(page.getByRole('banner')).toContainText('保存中');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出对话' }).click();
    const saved = await download;
    const exported = await readFile((await saved.path())!, 'utf8');
    expect(exported).toContain('验证持久化导出'); expect(exported).not.toContain('正文');
    await expect(answer).toHaveAttribute('data-status', 'completed');
    await expect(page.getByRole('banner')).toContainText('已同步');
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:selected')!) as string);
    const stored = await context.request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    const cached = await page.evaluate((id) => JSON.parse(localStorage.getItem(`everchat:snapshot:${id}`)!), id) as Snapshot;
    expect(cached).toEqual(stored);
    const writes = await page.evaluate(() => (window as unknown as { snapshotWrites: Snapshot[] }).snapshotWrites);
    expect(writes.length).toBeLessThan(10);
    for (const write of writes) for (const message of write.messages) expect(message.liveOffset).toBeUndefined();
    expect(stored.messages[1].content).toBe('正文🙂'.repeat(2000));
  } finally {
    expect((await context.request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});

test('failed persistence drops the preview tail without publishing a durable confirmation', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  let socket: WebSocket | undefined;
  try {
    const providerId = crypto.randomUUID(), id = crypto.randomUUID();
    expect((await request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Failed save', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'alarm-cancel-tail-failure', name: 'Storage failure', enabled: true }] }],
      activeProviderId: providerId, activeModel: 'alarm-cancel-tail-failure', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).ok()).toBe(true);
    expect((await request.post('/api/conversations', { headers, data: { id, title: 'Failed save' } })).status()).toBe(201);
    const live = await subscribe(request, id); socket = live.socket;
    expect((await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '不误报保存' } })).status()).toBe(202);
    await expect.poll(() => live.snapshot().messages[1]?.status).toBe('failed');
    expect(live.packets.some((packet) => packet.type === 'preview')).toBe(true);
    const acknowledgements = live.packets.filter((packet) => packet.type === 'commit-ack');
    expect(acknowledgements).toHaveLength(1);
    const previews = live.packets.filter((packet) => packet.type === 'preview');
    expect(acknowledgements[0].endOffset).toBeLessThan(previews.at(-1)!.batch.endOffset);
    expect(live.view()).toEqual(live.snapshot()); expect(live.snapshot().messages[1].content).toBe('停止前的内容'.repeat(2000));
    expect(live.snapshot()).toEqual(await request.get(`/api/conversations/${id}`).then((response) => response.json()));
  } finally {
    socket?.terminate();
    expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});

test('logging out clears cached messages even when a delayed durable snapshot write is pending', async ({ page, context }) => {
  expect((await context.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await context.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  let id: string | undefined;
  try {
    const providerId = crypto.randomUUID();
    expect((await context.request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Logout cache', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-text-30-200-200', name: 'Pending write', enabled: true }] }],
      activeProviderId: providerId, activeModel: 'benchmark-text-30-200-200', systemPrompt: '', maxOutputTokens: null, showReasoning: false,
    } })).ok()).toBe(true);
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('退出时清除私密缓存');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const answer = page.getByTestId('assistant-message');
    await expect.poll(async () => Number(await answer.getAttribute('data-durable-offset')), { intervals: [50] }).toBeGreaterThan(0);
    id = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:selected')!) as string);
    await page.getByRole('button', { name: '空间设置' }).click();
    await page.getByRole('button', { name: '退出并清除本地记录' }).click();
    await expect(page.getByLabel('访问密码')).toBeVisible();
    // Advance beyond the cache writer's two-second window and sample throughout it.
    const samples = await page.evaluate(async () => {
      const found: string[] = [];
      for (let i = 0; i < 25; i++) {
        found.push(...Object.keys(localStorage).filter((key) => key.startsWith('everchat:snapshot:')));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return found;
    });
    expect(samples).toEqual([]);
    const keys = await page.evaluate(() => new Promise<IDBValidKey[]>((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction('keyval').objectStore('keyval').getAllKeys();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { resolve(request.result); open.result.close(); };
      };
    }));
    expect(keys.filter((key) => String(key).startsWith('everchat:snapshot:'))).toEqual([]);
  } finally {
    expect((await context.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
    if (id) {
      const stored = await context.request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
      const active = stored.messages.find((message) => message.status === 'running' || message.status === 'queued');
      if (active) expect((await context.request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId: active.runId } })).ok()).toBe(true);
    }
    expect((await context.request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  }
});
