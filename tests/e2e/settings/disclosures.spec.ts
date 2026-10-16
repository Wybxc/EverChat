import { expect,test,type Locator,type Page } from '@playwright/test';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openModelAdder,openSpaceSettings,providerDetails } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function fixture(page: Page) {
  expect((await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const original = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const provider = crypto.randomUUID(), id = crypto.randomUUID();
  expect((await page.request.put('/api/settings/providers', { headers, data: {
    ...original, activeProviderId: provider, activeModel: 'test-model', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
    providers: [{ id: provider, name: '紧凑布局', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
      models: [{ id: 'test-model', name: 'test-model', enabled: true, reasoningSupport: 'supported' }, { id: 'second-model', name: '备用模型', enabled: true }] }],
  } })).ok()).toBe(true);
  expect((await page.request.post('/api/conversations', { headers, data: { id, title: '紧凑布局回归' } })).status()).toBe(201);
  return { id, cleanup: async () => {
    await page.close();
    await page.request.delete(`/api/conversations/${id}`, { headers });
    expect((await page.request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(true);
  } };
}

const isOpen = (details: Locator) => details.evaluate((node: HTMLDetailsElement) => node.open);

const group = (dialog: Locator, title: string) => dialog.locator('details').filter({ has: dialog.page().locator('summary').filter({ hasText: new RegExp(`^${title}`) }) });

async function settingsTab(page: Page, name: string) {
  const tab = page.getByRole('dialog', { name: '设置', exact: true }).getByRole('tab', { name, exact: true });
  await tab.focus(); await tab.press('Space');
}

test('model disclosures preserve drafts and focus, remember capabilities within the window, and expose invalid fields', async ({ page }) => {
  const source = await fixture(page);
  try {
    await page.goto('/'); await openSpaceSettings(page); await settingsTab(page, '供应商'); await providerDetails(page);
    const rows = page.getByTestId('provider-model-row');
    await expect(rows.first()).toHaveText('test-model');
    await expect(page.getByLabel('新模型 ID', { exact: true })).not.toBeVisible();
    await openModelAdder(page);
    const draft = page.getByLabel('新模型 ID', { exact: true });
    const adder = page.locator('details').filter({ has: draft });
    await expect(draft).toBeFocused(); await draft.fill('unsent-model');
    await adder.locator('summary').click(); await expect(draft).not.toBeVisible();
    await settingsTab(page, '对话'); await settingsTab(page, '供应商');
    await openModelAdder(page); await expect(draft).toHaveValue('unsent-model');
    await draft.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(rows).toHaveCount(2);
    await page.getByRole('button', { name: '取消添加', exact: true }).click();
    await expect(adder.locator('summary')).toBeFocused();
    await openModelAdder(page); await expect(draft).toHaveValue('');
    await adder.locator('summary').click();

    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    const capability = group(rows.first(), '模型能力');
    await expect.poll(() => isOpen(capability)).toBe(false);
    await expect(page.getByLabel('模型 ID 1', { exact: true })).toBeVisible();
    await capability.locator('summary').click();
    const limit = page.getByLabel('上下文窗口（Tokens） 1', { exact: true });
    await limit.fill('0'); await expect(limit).toBeFocused(); await expect(limit).toHaveAttribute('aria-invalid', 'true');
    await capability.locator('summary').click();
    await expect.poll(() => isOpen(capability)).toBe(true);
    await expect(capability.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('settings-save-status')).toContainText('未保存');
    await limit.fill('32768'); await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    await expect(capability.locator('summary')).toContainText('自定义');
    await page.getByRole('button', { name: '模型设置 2', exact: true }).click();
    await expect.poll(() => isOpen(group(rows.nth(1), '模型能力'))).toBe(false);
    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    await expect.poll(() => isOpen(capability)).toBe(true);
    await settingsTab(page, '通用'); await settingsTab(page, '供应商');
    await expect.poll(() => isOpen(capability)).toBe(true);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await openSpaceSettings(page); await providerDetails(page);
    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    await expect.poll(() => isOpen(capability)).toBe(false);
  } finally { await source.cleanup(); }
});

test('conversation groups open by task, reveal invalid generation values, and keep collapsed costs and service errors visible', async ({ page }) => {
  const source = await fixture(page);
  try {
    await page.route('**/api/settings/web-tools', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test unavailable"}' }));
    await page.goto(`/c/${source.id}`);
    await page.getByRole('button', { name: '会话参数', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '会话参数', exact: true });
    for (const [name, expected] of [['系统提示词', true], ['生成参数', false], ['联网工具', false], ['上下文', false]] as const) {
      await expect.poll(() => isOpen(group(dialog, name))).toBe(expected);
    }
    const generation = group(dialog, '生成参数'); await generation.locator('summary').click();
    await dialog.getByLabel('输出上限方式', { exact: true }).selectOption('custom');
    const limit = dialog.getByLabel('输出 Token 上限', { exact: true });
    await limit.fill('0'); await expect(limit).toBeFocused();
    await generation.locator('summary').click(); await expect.poll(() => isOpen(generation)).toBe(true);
    await expect(limit).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('alert').filter({ hasText: '请检查参数' })).toBeVisible();
    await limit.fill('64'); await expect(dialog.getByRole('status')).toHaveText('已保存');
    await dialog.getByRole('button', { name: '关闭会话参数' }).click();
    await page.getByRole('button', { name: '联网工具', exact: true }).click();
    await expect.poll(() => isOpen(group(dialog, '联网工具'))).toBe(true);
    await group(dialog, '联网工具').locator('summary').click();
    await expect(dialog.getByText('无法读取联网服务配置。', { exact: true })).toBeVisible();
    await expect.poll(() => isOpen(group(dialog, '联网工具'))).toBe(false);
    await dialog.getByRole('button', { name: '关闭会话参数' }).click();

    const settings = { ...DEFAULT_CONVERSATION_SETTINGS, tools: ['web_search'], autoCompression: { ...DEFAULT_CONVERSATION_SETTINGS.autoCompression, enabled: true } };
    expect((await page.request.put(`/api/conversations/${source.id}/settings`, { headers, data: settings })).ok()).toBe(true);
    await page.reload(); await page.getByRole('button', { name: '会话参数', exact: true }).click();
    await expect.poll(() => isOpen(group(dialog, '联网工具'))).toBe(true);
    await group(dialog, '联网工具').locator('summary').click();
    await expect(dialog.getByText('开启后可能增加搜索服务与模型费用。每个新对话默认关闭。', { exact: true })).toBeVisible();
    await expect.poll(() => isOpen(group(dialog, '上下文'))).toBe(false);
    await expect(dialog.getByText('开启后会额外调用摘要模型，产生供应商费用。原始消息保留。', { exact: true })).toBeVisible();
  } finally { await source.cleanup(); }
});
