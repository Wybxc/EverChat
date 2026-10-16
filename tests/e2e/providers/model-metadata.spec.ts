import { expect,test,type APIRequestContext,type Page } from '@playwright/test';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderSettings,SessionInfo } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { editModel,openParameters,openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function login(page: Page) {
  await page.goto('/'); await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}
async function providers(page: Page) {
  await openSpaceSettings(page);
  const tab = page.getByRole('tab', { name: '供应商', exact: true }); await tab.focus(); await tab.press('Space');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
async function saved(page: Page) { await expect(page.getByTestId('settings-save-status')).toHaveText('已保存'); }
async function modelOptions(page: Page) { await editModel(page); }
const getSettings = (request: APIRequestContext) => request.get('/api/settings/providers').then((response) => response.json()) as Promise<ProviderSettings>;

test('unknown model metadata is visible, editable, automatically saved across devices and resettable', async ({ page, context, browser }) => {
  await login(page);
  const initial = await getSettings(context.request), providerId = crypto.randomUUID();
  try {
    expect((await context.request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: 'Metadata fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [{ id: 'custom-model', name: 'Custom Model', enabled: true }] }],
      activeProviderId: providerId, activeModel: 'custom-model', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    } })).status()).toBe(200);
    await page.reload(); await providers(page); await modelOptions(page);
    const window = page.getByLabel('上下文窗口（Tokens） 1', { exact: true });
    const maximum = page.getByLabel('最大输出（Tokens） 1', { exact: true });
    await expect(window).toHaveValue(''); await expect(window).toHaveAttribute('placeholder', '32768');
    await expect(maximum).toHaveAttribute('placeholder', '8192');
    await expect(page.getByLabel('图片输入 1')).toContainText('自动（未识别，可尝试）');
    await expect(page.getByText('未识别', { exact: true }).first()).toBeVisible();
    await window.fill('65536'); await saved(page); await expect(window).toBeFocused();
    await maximum.fill('2048');
    await page.getByLabel('窗口范围 1').selectOption('input');
    await page.getByLabel('图片输入 1').selectOption('supported');
    await page.getByLabel('工具调用 1').selectOption('unsupported');
    await page.getByLabel('结构化输出 1').selectOption('supported');
    await page.getByLabel('思考能力 1').selectOption('supported');
    await page.getByLabel('自定义思维强度 1').check();
    await page.getByLabel('思维强度 低 1', { exact: true }).uncheck();
    await page.getByLabel('思维强度 中 1', { exact: true }).uncheck(); await saved(page);
    const configured = await getSettings(context.request);
    expect(configured.maxOutputTokens).toBeNull();
    expect(configured.providers[0].models[0]).toMatchObject({ reasoningSupport: 'supported', metadataOverrides: {
      contextWindow: 65536, contextScope: 'input', maxOutputTokens: 2048, imageInput: true, toolCalls: false, structuredOutput: true, reasoningEfforts: ['high'],
    } });
    const session = await context.request.get('/api/session').then((response) => response.json()) as SessionInfo;
    expect(session.models![0].metadata).toMatchObject({ contextWindow: 65536, maxOutputTokens: 2048, reasoning: true, reasoningEfforts: ['high'], sources: { contextWindow: 'manual', reasoning: 'manual' } });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByLabel('思维强度', { exact: true }).locator('option')).toHaveText(['思考', '高']);
    await page.reload(); await providers(page); await modelOptions(page);
    await expect(window).toHaveValue('65536'); await expect(maximum).toHaveValue('2048');
    const other = await browser.newContext({ baseURL: 'http://127.0.0.1:5174', storageState: await context.storageState() });
    try {
      const second = await other.newPage(); await second.goto('/'); await expect(second.getByLabel('消息', { exact: true })).toBeVisible();
      await providers(second); await modelOptions(second);
      await expect(second.getByLabel('上下文窗口（Tokens） 1')).toHaveValue('65536');
      await expect(second.getByLabel('思维强度 高 1', { exact: true })).toBeChecked();
    } finally { await other.close(); }
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await openParameters(page);
    await page.getByLabel('输出上限方式').selectOption('custom');
    await page.getByLabel('输出 Token 上限', { exact: true }).fill('2049');
    await page.getByRole('button', { name: '关闭会话参数', exact: true }).click();
    await page.getByLabel('消息', { exact: true }).fill('保留无效上限的草稿');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('2,048');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留无效上限的草稿');
    await expect(page).toHaveURL('http://127.0.0.1:5174/');
    await providers(page); await modelOptions(page);
    await page.getByLabel('自定义思维强度 1').uncheck(); await saved(page);
    expect((await getSettings(context.request)).providers[0].models[0].metadataOverrides).not.toHaveProperty('reasoningEfforts');
    await expect(page.getByLabel('上下文窗口（Tokens） 1')).toHaveValue('65536');
    await page.getByLabel('图片输入 1').selectOption('auto'); await saved(page);
    expect((await getSettings(context.request)).providers[0].models[0].metadataOverrides).not.toHaveProperty('imageInput');
    await maximum.fill(''); await saved(page);
    await expect(maximum).toHaveAttribute('placeholder', '8192');
    expect((await getSettings(context.request)).providers[0].models[0].metadataOverrides).not.toHaveProperty('maxOutputTokens');
    await maximum.fill('2048');
    await page.getByLabel('自定义思维强度 1').check();
    await page.getByLabel('思维强度 低 1', { exact: true }).uncheck();
    await page.getByLabel('思维强度 中 1', { exact: true }).uncheck(); await saved(page);
    await page.getByLabel('思维强度 高 1', { exact: true }).uncheck(); await saved(page);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByLabel('思维强度', { exact: true })).toHaveCount(0);
    await providers(page); await modelOptions(page);
    await maximum.fill('0');
    await expect(page.getByTestId('settings-save-status')).toContainText('Token 限制');
    expect((await getSettings(context.request)).providers[0].models[0].metadataOverrides!.maxOutputTokens).toBe(2048);
    await maximum.fill('1024'); await saved(page);
    await context.setOffline(true); await window.fill('32769');
    await expect(page.getByTestId('settings-save-status')).toHaveAttribute('role', 'alert');
    await expect(window).toHaveValue('32769');
    await context.setOffline(false); await saved(page);
    expect((await getSettings(context.request)).providers[0].models[0].metadataOverrides!.contextWindow).toBe(32769);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '恢复自动', exact: true }).click(); await saved(page);
    await expect(window).toHaveValue(''); await expect(maximum).toHaveValue('');
    await expect(page.getByLabel('思考能力 1')).toHaveValue('auto');
    expect((await getSettings(context.request)).providers[0].models[0]).not.toHaveProperty('metadataOverrides');
    await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport();
  } finally { await context.setOffline(false); await page.close(); expect((await context.request.put('/api/settings/providers', { headers, data: initial })).status()).toBe(200); }
});

test('native discovery refreshes reported metadata while preserving overrides, enabled choices and names; changing identity clears reports', async ({ page, context }) => {
  await login(page);
  const initial = await getSettings(context.request), providerId = crypto.randomUUID();
  try {
    expect((await context.request.put('/api/settings/providers', { headers, data: {
      ...initial, activeProviderId: null, activeModel: '', providers: [{ id: providerId, name: 'Native metadata', provider: 'anthropic', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'test-model', name: 'My Claude', enabled: false, reportedMetadata: { contextWindow: 12345, imageInput: false }, metadataOverrides: { contextWindow: 65536, toolCalls: true } }],
      }],
    } })).status()).toBe(200);
    await page.reload(); await providers(page); await page.getByRole('button', { name: '获取', exact: true }).click();
    await expect(page.getByText('已获取 2 个模型', { exact: true })).toBeVisible();
    await editModel(page);
    await expect(page.getByLabel('模型显示名 1')).toHaveValue('My Claude');
    await expect(page.getByLabel('启用模型 My Claude', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('启用模型 Second Claude', { exact: true })).not.toBeChecked();
    const model = (await getSettings(context.request)).providers[0].models[0];
    expect(model.reportedMetadata).toMatchObject({ contextWindow: 200000, contextScope: 'input', maxOutputTokens: 64000, imageInput: true, structuredOutput: false, reasoning: true, reasoningEfforts: ['low', 'high'] });
    expect(model.metadataOverrides).toEqual({ contextWindow: 65536, toolCalls: true });
    await modelOptions(page);
    await expect(page.getByLabel('上下文窗口（Tokens） 1')).toHaveValue('65536');
    await expect(page.getByLabel('最大输出（Tokens） 1')).toHaveAttribute('placeholder', '64000');
    await expect(page.getByLabel('图片输入 1')).toContainText('自动（支持）');
    await page.getByRole('button', { name: '获取', exact: true }).click(); await saved(page);
    expect((await getSettings(context.request)).providers[0].models[0]).toEqual(model);
    await page.getByLabel('模型 ID 1', { exact: true }).fill('renamed-model'); await saved(page);
    expect((await getSettings(context.request)).providers[0].models[0]).not.toHaveProperty('reportedMetadata');
    await expect(page.getByLabel('最大输出（Tokens） 1')).toHaveAttribute('placeholder', '8192');
    // Native Gemini fields follow its own schema and do not include embedding-only entries.
    const gemini = { ...await getSettings(context.request), providers: [{ id: providerId, name: 'Gemini', provider: 'gemini', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [] }] };
    expect((await context.request.put('/api/settings/providers', { headers, data: gemini })).status()).toBe(200);
    const discovered = await context.request.get(`/api/settings/providers/${providerId}/models`).then((response) => response.json());
    expect(discovered.models).toEqual([{ id: 'test-model', name: 'Discovered Gemini', reportedMetadata: { contextWindow: 1048576, contextScope: 'input', maxOutputTokens: 65536, reasoning: true } }]);
  } finally { await page.close(); expect((await context.request.put('/api/settings/providers', { headers, data: initial })).status()).toBe(200); }
});

test('server validates effective output and effort limits before accepting a run and pins model metadata in accepted tasks and backups', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await getSettings(request), providerId = crypto.randomUUID(), id = crypto.randomUUID();
  const copies: string[] = [];
  const configuration = { providers: [{ id: providerId, name: 'Pinned metadata', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
    models: [{ id: 'alarm-stall', name: 'Pinned Model', enabled: true, reasoningSupport: 'supported', reportedMetadata: { contextWindow: 2048, maxOutputTokens: 512, reasoning: true }, metadataOverrides: { contextWindow: 1024, maxOutputTokens: 256, imageInput: false, reasoningEfforts: ['low'] } }],
  }], activeProviderId: providerId, activeModel: 'alarm-stall', systemPrompt: '', maxOutputTokens: null, showReasoning: false };
  const submit = async (patch: object = {}) => {
    const snapshot = await request.get(`/api/conversations/${id}`).then((response) => response.json()) as Snapshot;
    const parentId = [...snapshot.messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)?.id ?? null;
    return request.post(`/api/conversations/${id}/messages`, { headers, data: { parentId, requestId: crypto.randomUUID(), content: 'Pin metadata', ...patch } });
  };
  const snapshot = () => request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>;
  const run = (runId: string) => request.post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } }).then((response) => response.json());
  try {
    expect((await request.put('/api/settings/providers', { headers, data: configuration })).status()).toBe(200);
    expect((await request.post('/api/conversations', { headers, data: { id, title: 'Pinned metadata' } })).status()).toBe(201);
    const invalid = await submit({ settings: { ...DEFAULT_CONVERSATION_SETTINGS, useGlobalMaxOutputTokens: false, maxOutputTokens: 257 } });
    expect(invalid.status()).toBe(400); expect((await invalid.json()).error).toContain('256');
    expect((await submit({ reasoningEffort: 'high' })).status()).toBe(400);
    expect((await snapshot()).messages).toHaveLength(0);
    const accepted = await submit({ reasoningEffort: 'low' }); expect(accepted.status()).toBe(202);
    const task = await accepted.json() as Submission;
    const first = (await run(task.runId)).config;
    expect(first.maxOutputTokens).toBeNull(); expect(first.modelMetadata).toMatchObject({ contextWindow: 1024, maxOutputTokens: 256, reasoningEfforts: ['low'], sources: { maxOutputTokens: 'manual' } });
    const changed = structuredClone(configuration); changed.providers[0].models[0].metadataOverrides.maxOutputTokens = 768;
    expect((await request.put('/api/settings/providers', { headers, data: changed })).status()).toBe(200);
    expect((await run(task.runId)).config).toEqual(first);
    const backup = await request.get(`/api/conversations/${id}/backup`).then((response) => response.json());
    expect(backup.settings.providers[0].models[0].metadataOverrides.maxOutputTokens).toBe(768);
    expect(JSON.stringify(backup)).not.toContain('integration-test-key');
    expect((await request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId: task.runId } })).status()).toBe(200);
    const next = await submit({ settings: { ...DEFAULT_CONVERSATION_SETTINGS, useGlobalMaxOutputTokens: false, maxOutputTokens: 512 } }); expect(next.status()).toBe(202);
    const nextTask = await next.json() as Submission;
    expect((await run(nextTask.runId)).config).toMatchObject({ maxOutputTokens: 512, modelMetadata: { maxOutputTokens: 768 } });
    await request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId: nextTask.runId } });
    const otherEndpoint = { ...changed, providers: [{ ...changed.providers[0], baseUrl: 'https://provider.test/v2' }] };
    expect((await request.put('/api/settings/providers', { headers, data: otherEndpoint })).status()).toBe(200);
    expect((await getSettings(request)).providers[0].models[0]).not.toHaveProperty('reportedMetadata');
    const restored = await request.post('/api/backup/restore', { headers, data: backup }); expect(restored.status()).toBe(201);
    copies.push((await restored.json()).id);
    const restoredSettings = await getSettings(request);
    expect(restoredSettings.providers[0].models).toEqual(backup.settings.providers[0].models);
    expect(restoredSettings.activeProviderId).toBeNull();
  } finally {
    for (const conversation of [id, ...copies]) await request.delete(`/api/conversations/${conversation}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: initial })).status()).toBe(200);
  }
});
