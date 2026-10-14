import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import type { ConversationSettings, ProviderSettings, Snapshot, Submission, SyncPacket } from '../../shared/types';
import { DEFAULT_CONVERSATION_SETTINGS as defaults } from '../../shared/conversation-settings';
import { modelSelectionKey } from '../../shared/models';

const origin = 'http://127.0.0.1:5174', headers = { Origin: origin };
async function setup(request: APIRequestContext, model = 'alarm-stall') {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const original = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID(), id = crypto.randomUUID();
  const config = { providers: [{ id: providerId, name: 'Parameters fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
    models: [{ id: model, name: 'Parameters fixture', enabled: true, useGlobalSystemPrompt: false, systemPrompt: 'MODEL' }, { id: 'o3', name: 'Reasoning fixture', enabled: true }] }],
    activeProviderId: providerId, activeModel: model, systemPrompt: 'GLOBAL', maxOutputTokens: 128, showReasoning: false };
  expect((await request.put('/api/settings/providers', { headers, data: config })).ok()).toBe(true);
  expect((await request.post('/api/conversations', { headers, data: { id, title: '会话参数测试' } })).status()).toBe(201);
  const snapshot = () => request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>;
  const save = (settings: ConversationSettings) => request.put(`/api/conversations/${id}/settings`, { headers, data: settings });
  const run = (runId: string) => request.post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } }).then((response) => response.json());
  const stop = (runId: string) => request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId } });
  return { id, providerId, config, snapshot, save, run, stop, cleanup: async (extra: string[] = []) => {
    for (const conversation of [id, ...extra]) await request.delete(`/api/conversations/${conversation}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(true);
  } };
}

async function replay(request: APIRequestContext, id: string) {
  const { cookies } = await request.storageState();
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`, { headers: { ...headers, Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') } });
  const packets: SyncPacket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Replay timeout')), 10_000);
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      socket.on('message', (data) => { const packet = JSON.parse(data.toString()) as SyncPacket; packets.push(packet); if (packet.type === 'ready') { clearTimeout(timer); resolve(); } });
    });
    return packets;
  } finally { socket.terminate(); }
}

test('conversation settings validate, inherit and pin task configuration, and survive replay, copies and backups', async ({ request }) => {
  const unauthenticated = `/api/conversations/${crypto.randomUUID()}/settings`;
  expect((await request.put(unauthenticated, { headers, data: defaults })).status()).toBe(401);
  const fixture = await setup(request), copies: string[] = [];
  try {
    expect((await fixture.snapshot()).settings).toEqual(defaults);
    expect((await request.put(`/api/conversations/${fixture.id}/settings`, { data: defaults })).status()).toBe(403);
    for (const patch of [{ temperature: 3 }, { topP: -1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.2 }, { systemPrompt: 'x'.repeat(20001) }, { apiKey: 'unexpected' }]) expect((await fixture.save({ ...defaults, ...patch } as ConversationSettings)).status()).toBe(400);
    const settings = { ...defaults, systemPrompt: '系统🙂'.repeat(4500), temperature: 0, topP: 0.8, useGlobalMaxOutputTokens: false };
    expect((await fixture.save(settings)).status()).toBe(200);
    const seq = (await fixture.snapshot()).seq;
    expect((await fixture.save(settings)).status()).toBe(200); expect((await fixture.snapshot()).seq).toBe(seq);
    // The combined prompt and message exceed 64 KB while remaining within their individual limits.
    const input = { requestId: crypto.randomUUID(), content: '固定任务配置'.repeat(2000), settings };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(64 * 1024);
    const sent = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: input }); expect(sent.status()).toBe(202);
    const submission = await sent.json() as Submission;
    const first = await fixture.run(submission.runId);
    expect(first.config).toMatchObject({ systemPrompt: settings.systemPrompt, temperature: 0, topP: 0.8, maxOutputTokens: null });
    expect(first.config).not.toHaveProperty('apiKey');
    const later = { ...defaults, systemPrompt: 'NEXT', useGlobalMaxOutputTokens: false, maxOutputTokens: 256 };
    expect((await fixture.save(later)).status()).toBe(200);
    expect((await fixture.run(submission.runId)).config).toEqual(first.config);
    expect(await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: input }).then((response) => response.json())).toEqual(submission);
    await fixture.stop(submission.runId);
    expect((await fixture.save(defaults)).status()).toBe(200);
    const inherited = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '继承模型提示' } }).then((response) => response.json()) as Submission;
    expect((await fixture.run(inherited.runId)).config).toMatchObject({ systemPrompt: 'MODEL', maxOutputTokens: 128 });
    await fixture.stop(inherited.runId);
    expect((await request.put('/api/settings/providers', { headers, data: { ...fixture.config,
      providers: fixture.config.providers.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model, useGlobalSystemPrompt: true })) })),
    } })).status()).toBe(200);
    const global = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '继承全局提示' } }).then((response) => response.json()) as Submission;
    expect((await fixture.run(global.runId)).config).toMatchObject({ systemPrompt: 'GLOBAL', maxOutputTokens: 128 });
    await fixture.stop(global.runId);
    const empty = { ...defaults, systemPrompt: '', useGlobalMaxOutputTokens: false };
    const explicit = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '取消提示和上限', settings: empty } }).then((response) => response.json()) as Submission;
    expect((await fixture.run(explicit.runId)).config).toMatchObject({ systemPrompt: '', maxOutputTokens: null });
    expect((await fixture.snapshot()).settings).toEqual(defaults);
    await fixture.stop(explicit.runId);
    // Explicitly saving inherited defaults must not be overwritten by an older queued first message.
    const fresh = crypto.randomUUID(); copies.push(fresh);
    expect((await request.post('/api/conversations', { headers, data: { id: fresh, title: '已配置继承参数' } })).status()).toBe(201);
    expect((await request.put(`/api/conversations/${fresh}/settings`, { headers, data: defaults })).status()).toBe(200);
    expect(await request.get(`/api/conversations/${fresh}`).then((response) => response.json())).toMatchObject({ seq: 0, settings: defaults });
    const queued = await request.post(`/api/conversations/${fresh}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '离线参数快照', settings: empty } });
    expect(queued.status()).toBe(202);
    const queuedRun = (await queued.json() as Submission).runId;
    const pinned = await request.post(`/api/__test/conversations/${fresh}/context`, { headers, data: { runId: queuedRun } }).then((response) => response.json());
    expect(pinned.config).toMatchObject({ systemPrompt: '', maxOutputTokens: null });
    expect(await request.get(`/api/conversations/${fresh}`).then((response) => response.json())).toMatchObject({ settings: defaults });
    expect((await replay(request, fresh)).find((packet) => packet.type === 'change')).toMatchObject({ settings: defaults });
    await request.post(`/api/conversations/${fresh}/cancel`, { headers, data: { runId: queuedRun } });
    expect((await fixture.save(later)).status()).toBe(200);
    const packets = await replay(request, fixture.id);
    const changes = packets.filter((packet) => packet.type === 'change' && packet.settings);
    expect(changes.at(-1)).toMatchObject({ settings: later });
    const copied = await request.post(`/api/conversations/${fixture.id}/duplicate`, { headers }).then((response) => response.json()); copies.push(copied.id);
    expect(copied.snapshot.settings).toEqual(later);
    const backup = await request.get(`/api/conversations/${fixture.id}/backup`).then((response) => response.json());
    expect(backup.conversation.settings).toEqual(later);
    const restored = await request.post('/api/backup/restore', { headers, data: backup }).then((response) => response.json()); copies.push(restored.id);
    expect(restored.snapshot.settings).toEqual(later);
    await request.delete(`/api/conversations/${fixture.id}`, { headers });
    expect((await fixture.save(defaults)).status()).toBe(410);
  } finally { await fixture.cleanup(copies); }
});

test('logging out cannot restore parameter drafts when an earlier autosave response arrives late', async ({ page }) => {
  const fixture = await setup(page.request);
  const prompt = '退出时清除私密参数';
  let release!: () => void, saved!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const reachedServer = new Promise<void>((resolve) => { saved = resolve; });
  try {
    await page.goto('/'); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const local = page.getByRole('dialog', { name: '新对话参数', exact: true });
    await local.getByLabel('自定义会话系统提示词').check(); await local.getByLabel('会话系统提示词', { exact: true }).fill('清除新对话本机参数');
    await expect(local.getByRole('status')).toHaveText('已保存到本机');
    await local.getByRole('button', { name: '关闭会话参数' }).click();
    await page.route('**/api/conversations/*/settings', async (route) => {
      if (route.request().postDataJSON()?.systemPrompt !== prompt) { await route.continue(); return; }
      const response = await route.fetch(); saved(); await hold; await route.fulfill({ response });
    });
    await page.goto(`/c/${fixture.id}`); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '会话参数', exact: true });
    await modal.getByLabel('自定义会话系统提示词').check(); await modal.getByLabel('会话系统提示词', { exact: true }).fill(prompt);
    await reachedServer;
    await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    await page.getByRole('button', { name: '退出并清除本地记录' }).click();
    await expect(page.getByLabel('访问密码')).toBeVisible();
    const late = page.waitForResponse((response) => response.url().endsWith(`/conversations/${fixture.id}/settings`) && response.request().postDataJSON()?.systemPrompt === prompt);
    release(); await late;
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('everchat:conversation-settings')))).toEqual([]);
    await page.getByLabel('访问密码').fill('everchat-local'); await page.getByRole('button', { name: '进入我的空间' }).click();
    await page.getByRole('button', { name: '会话参数', exact: true }).click();
    await expect(local.getByLabel('自定义会话系统提示词')).not.toBeChecked();
  } finally {
    release(); await page.unroute('**/api/conversations/*/settings');
    await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    await fixture.cleanup();
  }
});

test('conversation settings autosave, preserve failed and invalid drafts, sync devices and hide unsupported sampling controls', async ({ page, browser }) => {
  const fixture = await setup(page.request);
  const second = await browser.newContext();
  try {
    await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    const other = await second.newPage(); await other.goto(`/c/${fixture.id}`);
    await other.getByRole('button', { name: '会话参数', exact: true }).click();
    const remote = other.getByRole('dialog', { name: '会话参数', exact: true });
    await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/c/${fixture.id}`);
    const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('保留聊天草稿');
    const trigger = page.getByRole('button', { name: '会话参数', exact: true }); await trigger.click();
    const modal = page.getByRole('dialog', { name: '会话参数', exact: true });
    await expect(modal.getByRole('button', { name: '关闭会话参数' })).toBeInViewport();
    await page.route('**/api/conversations/*/settings', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法保存参数' }) }));
    await modal.getByLabel('自定义会话系统提示词').check(); await modal.getByLabel('会话系统提示词', { exact: true }).fill('保留未保存的会话提示');
    await expect(modal.getByRole('alert')).toContainText('暂时无法保存参数');
    await page.reload(); await trigger.click(); await expect(modal.getByLabel('会话系统提示词', { exact: true })).toHaveValue('保留未保存的会话提示');
    await expect(modal.getByRole('alert')).toContainText('暂时无法保存参数');
    await page.unroute('**/api/conversations/*/settings'); await modal.getByRole('button', { name: '重试保存' }).click();
    await expect(modal.getByRole('status')).toHaveText('已保存');
    await expect(remote.getByLabel('会话系统提示词', { exact: true })).toHaveValue('保留未保存的会话提示');
    await modal.getByLabel('Temperature', { exact: true }).fill('3');
    await expect(modal.getByRole('alert')).toContainText('请检查参数');
    expect((await fixture.snapshot()).settings?.temperature).toBeNull();
    await modal.getByLabel('Temperature', { exact: true }).fill('0.7'); await modal.getByLabel('Top P', { exact: true }).fill('0.8');
    await modal.getByLabel('输出上限方式').selectOption('unset');
    await expect.poll(async () => (await fixture.snapshot()).settings).toEqual({ ...defaults, systemPrompt: '保留未保存的会话提示', temperature: 0.7, topP: 0.8, useGlobalMaxOutputTokens: false });
    await modal.getByLabel('输出上限方式').selectOption('custom'); await modal.getByLabel('输出 Token 上限').fill('256');
    await expect.poll(async () => (await fixture.snapshot()).settings?.maxOutputTokens).toBe(256);
    await expect(modal.getByRole('button', { name: '恢复继承' })).toBeInViewport();
    await modal.getByRole('button', { name: '关闭会话参数' }).click(); await expect(trigger).toBeFocused();
    await expect(composer).toHaveValue('保留聊天草稿');
    await page.getByLabel('聊天模型', { exact: true }).selectOption(modelSelectionKey({ providerId: fixture.providerId, model: 'o3' }));
    await trigger.click(); await expect(modal.getByLabel('Temperature', { exact: true })).toHaveCount(0); await expect(modal.getByLabel('Top P', { exact: true })).toHaveCount(0);
    await expect(modal.getByLabel('会话系统提示词', { exact: true })).toHaveValue('保留未保存的会话提示');
  } finally { await second.close(); await fixture.cleanup(); }
});

test('an offline new conversation pins its parameters without overwriting another device settings after acceptance', async ({ page, context, browser }) => {
  const fixture = await setup(page.request, 'benchmark-text-40-100-32');
  const other = await browser.newContext(); let id = '';
  try {
    await other.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    await page.goto('/'); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '新对话参数', exact: true });
    await modal.getByLabel('自定义会话系统提示词').check(); await modal.getByLabel('会话系统提示词', { exact: true }).fill('OFFLINE');
    await modal.getByLabel('Temperature', { exact: true }).fill('0.3'); await modal.getByLabel('输出上限方式').selectOption('unset');
    await expect(modal.getByRole('status')).toHaveText('已保存到本机'); await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await context.setOffline(true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('离线发送会话参数'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/); id = new URL(page.url()).pathname.split('/').at(-1)!;
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!)[0].input);
    expect(queued.settings).toEqual({ ...defaults, systemPrompt: 'OFFLINE', temperature: 0.3, useGlobalMaxOutputTokens: false });
    await other.request.post('/api/conversations', { headers, data: { id, title: '另一设备的对话参数' } });
    const cloud = { ...defaults, systemPrompt: 'CLOUD' };
    expect((await other.request.put(`/api/conversations/${id}/settings`, { headers, data: cloud })).ok()).toBe(true);
    await context.setOffline(false);
    await expect.poll(async () => (await other.request.get(`/api/conversations/${id}`).then((response) => response.json())).messages.length).toBe(2);
    const saved = await other.request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    const runId = saved.messages[1].runId!;
    const task = await other.request.post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } }).then((response) => response.json());
    expect(task.config).toMatchObject({ systemPrompt: 'OFFLINE', temperature: 0.3, maxOutputTokens: null });
    expect(saved.settings).toEqual(cloud);
    await page.close();
    await expect.poll(async () => (await other.request.get(`/api/conversations/${id}`).then((response) => response.json())).messages[1].status).toBe('completed');
    expect((await other.request.get(`/api/conversations/${id}`).then((response) => response.json())).settings).toEqual(cloud);
  } finally { await context.setOffline(false); await fixture.cleanup(id ? [id] : []); await other.close(); }
});
