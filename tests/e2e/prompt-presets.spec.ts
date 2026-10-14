import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { PromptPreset, ProviderSettings, Snapshot, Submission } from '../../shared/types';
import { DEFAULT_CONVERSATION_SETTINGS as defaults } from '../../shared/conversation-settings';
import type { EverChatBackup } from '../../shared/backup';

const headers = { Origin: 'http://127.0.0.1:5174' };
const list = (request: APIRequestContext) => request.get('/api/settings/presets').then((response) => response.json()) as Promise<PromptPreset[]>;
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).status()).toBe(200);
  const original = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const originalIds = new Set((await list(request)).map((preset) => preset.id));
  const providerId = crypto.randomUUID(), id = crypto.randomUUID();
  expect((await request.put('/api/settings/providers', { headers, data: {
    providers: [{ id: providerId, name: '预设测试供应商', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'preset-fixture-key', models: [{ id: 'alarm-stall', name: '预设测试', enabled: true }] }],
    activeProviderId: providerId, activeModel: 'alarm-stall', systemPrompt: 'GLOBAL', maxOutputTokens: null, showReasoning: false,
  } })).status()).toBe(200);
  expect((await request.post('/api/conversations', { headers, data: { id, title: '提示词预设测试' } })).status()).toBe(201);
  return { id, cleanup: async (extra: string[] = []) => {
    for (const conversation of [id, ...extra]) await request.delete(`/api/conversations/${conversation}`, { headers });
    for (const preset of await list(request)) if (!originalIds.has(preset.id)) await request.delete(`/api/settings/presets/${preset.id}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: original })).status()).toBe(200);
  } };
}
async function presetsTab(page: Page) {
  const tab = page.getByRole('tab', { name: '预设', exact: true });
  await tab.focus(); await tab.press('Space'); await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: '预设', exact: true });
}

test('preset APIs authorize writes, pin copied task prompts, and merge backups without overwriting local presets', async ({ request }) => {
  const id = crypto.randomUUID(), path = `/api/settings/presets/${id}`;
  expect((await request.get('/api/settings/presets')).status()).toBe(401);
  expect((await request.put(path, { headers, data: { name: '未登录', systemPrompt: '' } })).status()).toBe(401);
  expect((await request.delete(path, { headers })).status()).toBe(401);
  const fixture = await setup(request), copies: string[] = [];
  try {
    expect((await request.put(path, { data: { name: '缺少来源', systemPrompt: '' } })).status()).toBe(403);
    expect((await request.put('/api/settings/presets/bad', { headers, data: { name: '无效 ID', systemPrompt: '' } })).status()).toBe(404);
    for (const patch of [{ name: ' ' }, { systemPrompt: 'x'.repeat(20001) }, { apiKey: 'unexpected' }]) expect((await request.put(path, { headers, data: { name: '写作助手', systemPrompt: 'ROLE', ...patch } })).status()).toBe(400);
    const saved = await request.put(path, { headers, data: { name: ' 写作助手 ', systemPrompt: 'ROLE' } });
    expect(saved.status()).toBe(200); expect(saved.headers()['cache-control']).toBe('no-store');
    const preset = await saved.json() as PromptPreset; expect(preset.name).toBe('写作助手');
    expect(await request.put(path, { headers, data: { name: '写作助手', systemPrompt: 'ROLE' } }).then((response) => response.json())).toEqual(preset);
    const empty = crypto.randomUUID(); expect((await request.put(`/api/settings/presets/${empty}`, { headers, data: { name: '空提示词', systemPrompt: '' } })).status()).toBe(200);
    expect((await request.put(`/api/conversations/${fixture.id}/settings`, { headers, data: { ...defaults, systemPrompt: preset.systemPrompt } })).status()).toBe(200);
    const accepted = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '使用预设' } }).then((response) => response.json()) as Submission;
    const run = () => request.post(`/api/__test/conversations/${fixture.id}/context`, { headers, data: { runId: accepted.runId } }).then((response) => response.json());
    expect((await run()).config.systemPrompt).toBe('ROLE');
    const backup = await request.get(`/api/conversations/${fixture.id}/backup`).then((response) => response.json()) as EverChatBackup;
    expect(backup.settings.promptPresets).toContainEqual(preset); expect(JSON.stringify(backup)).not.toContain('preset-fixture-key');
    expect((await request.put(path, { headers, data: { name: '本机新版本', systemPrompt: 'ROLE 2' } })).status()).toBe(200);
    expect((await run()).config.systemPrompt).toBe('ROLE');
    for (let index = 0; index < 2; index++) {
      const response = await request.post('/api/backup/restore', { headers, data: backup }); expect(response.status()).toBe(201);
      const restored = await response.json(); copies.push(restored.id);
      expect(restored.snapshot.settings.systemPrompt).toBe('ROLE');
    }
    const merged = await list(request);
    expect(merged.find((item) => item.id === id)?.systemPrompt).toBe('ROLE 2');
    expect(merged.filter((item) => item.name === '写作助手' && item.systemPrompt === 'ROLE')).toHaveLength(1);
    expect((await request.delete(path, { headers })).status()).toBe(200);
    expect((await request.put(path, { headers, data: { name: '迟到保存', systemPrompt: 'ROLE 3' } })).status()).toBe(410);
    const snapshot = await request.get(`/api/conversations/${fixture.id}`).then((response) => response.json()) as Snapshot;
    expect(snapshot.settings?.systemPrompt).toBe('ROLE'); expect((await run()).config.systemPrompt).toBe('ROLE');
    await request.post(`/api/conversations/${fixture.id}/cancel`, { headers, data: { runId: accepted.runId } });
  } finally { await fixture.cleanup(copies); }
});

test('preset management autosaves and recovers drafts, applies copies, synchronizes devices and keeps deletion recoverable', async ({ page, browser }) => {
  const fixture = await setup(page.request), second = await browser.newContext();
  try {
    await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    await page.setViewportSize({ width: 390, height: 700 }); await page.goto(`/c/${fixture.id}`);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留聊天草稿');
    await page.getByRole('button', { name: '会话参数', exact: true }).click(); await page.getByRole('button', { name: '管理预设' }).click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    let panel = await presetsTab(page);
    await page.route('**/api/settings/presets/*', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法保存预设' }) }) : route.continue());
    await panel.getByRole('button', { name: '添加预设' }).click(); await expect(panel.getByLabel('预设名称', { exact: true })).toBeFocused();
    await panel.getByLabel('预设名称', { exact: true }).fill('写作助手'); await panel.getByLabel('预设系统提示词', { exact: true }).fill('你是写作助手。');
    await expect(panel.getByRole('alert')).toContainText('暂时无法保存预设');
    await page.reload(); await page.getByRole('button', { name: '空间设置', exact: true }).click(); panel = await presetsTab(page);
    await expect(panel.getByLabel('预设系统提示词', { exact: true })).toHaveValue('你是写作助手。');
    await expect(panel.getByRole('alert')).toContainText('暂时无法保存预设');
    await page.unroute('**/api/settings/presets/*'); await panel.getByRole('button', { name: '重试保存预设' }).click();
    await expect(panel.getByTestId('preset-save-status')).toHaveText('已自动保存');
    const preset = (await list(page.request)).find((item) => item.name === '写作助手')!;
    expect(preset.systemPrompt).toBe('你是写作助手。');
    await panel.getByLabel('预设名称', { exact: true }).fill(''); await panel.getByLabel('预设系统提示词', { exact: true }).focus();
    await expect(panel.getByRole('alert')).toContainText('预设名称'); expect((await list(page.request)).find((item) => item.id === preset.id)?.name).toBe('写作助手');
    await panel.getByLabel('预设名称', { exact: true }).fill('写作助手'); await expect(panel.getByTestId('preset-save-status')).toHaveText('已自动保存');
    await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport(); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const parameters = page.getByRole('dialog', { name: '会话参数', exact: true });
    await parameters.getByLabel('提示词预设', { exact: true }).selectOption(preset.id);
    await expect(parameters.getByLabel('会话系统提示词', { exact: true })).toHaveValue('你是写作助手。');
    await expect.poll(async () => (await page.request.get(`/api/conversations/${fixture.id}`).then((response) => response.json())).settings.systemPrompt).toBe('你是写作助手。');
    await parameters.getByRole('button', { name: '管理预设' }).click(); panel = await presetsTab(page);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await expect(parameters).toBeVisible();
    await parameters.getByRole('button', { name: '管理预设' }).click(); panel = await presetsTab(page);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await parameters.getByRole('button', { name: '关闭会话参数' }).click();
    await second.request.put(`/api/settings/presets/${preset.id}`, { headers, data: { name: '远端新名称', systemPrompt: '远端提示词' } });
    await page.getByRole('button', { name: '空间设置', exact: true }).click(); panel = await presetsTab(page);
    await expect(panel.getByLabel('预设名称', { exact: true })).toHaveValue('远端新名称');
    await page.route('**/api/settings/presets/*', (route) => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法删除预设' }) }) : route.continue());
    await panel.getByRole('button', { name: '删除预设', exact: true }).click(); await expect(panel.getByRole('button', { name: '取消删除预设' })).toBeFocused();
    await panel.getByRole('button', { name: '确认删除预设', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('暂时无法删除预设');
    await expect(panel.getByLabel('预设系统提示词', { exact: true })).toHaveValue('远端提示词');
    await page.unroute('**/api/settings/presets/*'); await panel.getByRole('button', { name: '确认删除预设', exact: true }).click();
    await expect(panel.getByRole('button', { name: '添加预设' })).toBeFocused();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    await expect(parameters.getByLabel('会话系统提示词', { exact: true })).toHaveValue('你是写作助手。');
    await parameters.getByRole('button', { name: '关闭会话参数' }).click(); await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留聊天草稿');
  } finally { await second.close(); await fixture.cleanup(); }
});

test('cached presets apply offline and queued tasks retain their text after the preset is deleted on another device', async ({ page, context, browser }) => {
  const fixture = await setup(page.request), second = await browser.newContext(); let newId = '';
  try {
    await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    const id = crypto.randomUUID(); await page.request.put(`/api/settings/presets/${id}`, { headers, data: { name: '离线预设', systemPrompt: 'OFFLINE ROLE' } });
    await page.goto(`/c/${fixture.id}`); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    await expect(page.getByLabel('提示词预设', { exact: true }).locator('option')).toContainText(['离线预设']);
    await page.getByRole('button', { name: '关闭会话参数' }).click(); await page.getByRole('button', { name: '开启新对话', exact: true }).click();
    await context.setOffline(true); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const parameters = page.getByRole('dialog', { name: '新对话参数', exact: true });
    await parameters.getByLabel('提示词预设', { exact: true }).selectOption(id); await expect(parameters.getByLabel('会话系统提示词', { exact: true })).toHaveValue('OFFLINE ROLE');
    await parameters.getByRole('button', { name: '关闭会话参数' }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('离线应用预设'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/); newId = new URL(page.url()).pathname.split('/')[2];
    await second.request.delete(`/api/settings/presets/${id}`, { headers }); await context.setOffline(false);
    await expect.poll(async () => (await second.request.get(`/api/conversations/${newId}`).then((response) => response.json())).messages?.length).toBe(2);
    const snapshot = await second.request.get(`/api/conversations/${newId}`).then((response) => response.json()) as Snapshot;
    expect(snapshot.settings?.systemPrompt).toBe('OFFLINE ROLE');
    const runId = snapshot.messages[1].runId!;
    expect((await second.request.post(`/api/__test/conversations/${newId}/context`, { headers, data: { runId } }).then((response) => response.json())).config.systemPrompt).toBe('OFFLINE ROLE');
    await second.request.post(`/api/conversations/${newId}/cancel`, { headers, data: { runId } });
  } finally { await context.setOffline(false); await second.close(); await fixture.cleanup(newId ? [newId] : []); }
});

test('a late preset autosave cannot repopulate local prompt caches after logout', async ({ page }) => {
  const fixture = await setup(page.request), prompt = '应清除的私密预设';
  let release!: () => void, ready!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; }), accepted = new Promise<void>((resolve) => { ready = resolve; });
  try {
    await page.route('**/api/settings/presets/*', async (route) => {
      if (route.request().method() !== 'PUT' || route.request().postDataJSON()?.systemPrompt !== prompt) { await route.continue(); return; }
      const response = await route.fetch(); ready(); await hold; await route.fulfill({ response });
    });
    await page.goto(`/c/${fixture.id}`); await page.getByRole('button', { name: '空间设置', exact: true }).click(); const panel = await presetsTab(page);
    await panel.getByRole('button', { name: '添加预设' }).click(); await panel.getByLabel('预设名称', { exact: true }).fill('私密预设'); await panel.getByLabel('预设系统提示词', { exact: true }).fill(prompt);
    await accepted;
    const general = page.getByRole('tab', { name: '通用', exact: true }); await general.focus(); await general.press('Space');
    await page.getByRole('button', { name: '退出并清除本地记录' }).click(); await expect(page.getByLabel('访问密码')).toBeVisible();
    const late = page.waitForResponse((response) => response.url().includes('/settings/presets/') && response.request().postDataJSON()?.systemPrompt === prompt);
    release(); await late; await page.waitForTimeout(100);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('everchat:prompt-preset')))).toEqual([]);
  } finally { release(); await page.unroute('**/api/settings/presets/*'); await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } }); await fixture.cleanup(); }
});

test('a dirty draft whose preset was deleted remotely can be saved under a new ID and discarded safely', async ({ page, browser }) => {
  const fixture = await setup(page.request), second = await browser.newContext(), id = crypto.randomUUID();
  try {
    await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    await page.request.put(`/api/settings/presets/${id}`, { headers, data: { name: '原预设', systemPrompt: '原内容' } });
    await page.goto(`/c/${fixture.id}`); await page.getByRole('button', { name: '空间设置', exact: true }).click(); const panel = await presetsTab(page);
    await panel.getByLabel('编辑预设', { exact: true }).selectOption(id);
    await page.route(`**/api/settings/presets/${id}`, (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法保存预设' }) }) : route.continue());
    await panel.getByLabel('预设系统提示词', { exact: true }).fill('待恢复的内容'); await expect(panel.getByRole('alert')).toContainText('暂时无法保存预设');
    await second.request.delete(`/api/settings/presets/${id}`, { headers }); await page.unroute(`**/api/settings/presets/${id}`);
    await panel.getByRole('button', { name: '重试保存预设' }).click(); await expect(panel.getByRole('alert')).toContainText('已删除');
    await expect(panel.getByLabel('预设系统提示词', { exact: true })).toHaveValue('待恢复的内容');
    await panel.getByRole('button', { name: '另存为新预设' }).click(); await expect(panel.getByTestId('preset-save-status')).toHaveText('已自动保存');
    const copy = (await list(page.request)).find((preset) => preset.systemPrompt === '待恢复的内容')!;
    expect(copy.id).not.toBe(id); expect(copy.name).toBe('原预设');
    expect((await page.request.put(`/api/settings/presets/${id}`, { headers, data: { name: '原预设', systemPrompt: '迟到内容' } })).status()).toBe(410);
    await panel.getByLabel('编辑预设', { exact: true }).selectOption(id); await panel.getByRole('button', { name: '删除预设', exact: true }).click();
    await panel.getByRole('button', { name: '确认删除预设', exact: true }).click();
    await expect(panel.getByLabel('编辑预设', { exact: true })).toHaveValue(copy.id);
    await expect(panel.getByLabel('预设系统提示词', { exact: true })).toHaveValue('待恢复的内容');
    expect(await page.evaluate((id) => id in JSON.parse(localStorage.getItem('everchat:prompt-preset-drafts') ?? '{}'), id)).toBe(false);
  } finally { await second.close(); await fixture.cleanup(); }
});
