import { test, expect, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../shared/types';
import { openSpaceSettings, chooseChatModel } from '../ui';
const headers = { Origin: 'http://127.0.0.1:5174' };
async function fixture(page: Page) {
  await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
  const original = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID();
  await page.request.put('/api/settings/providers', { headers, data: { ...original, showReasoning: true, activeProviderId: providerId, activeModel: 'test-model', providers: [{ id: providerId, name: 'UI Test', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [{ id: 'test-model', name: 'EverChat Test', enabled: true, reasoningSupport: 'supported' }, { id: 'test-model-2', name: 'Thinking Test', enabled: true, reasoningSupport: 'supported' }] }] } });
  return { providerId, cleanup: async () => { await page.request.put('/api/settings/providers', { headers, data: original }); } };
}

test('centered new chat keeps its composer, draft and focus when sending and navigating', async ({ page }, info) => {
  const data = await fixture(page); let id = '';
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/');
    const composer = page.getByTestId('chat-composer'), input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
    const box = (await composer.boundingBox())!; expect(box.width).toBeCloseTo(776); expect(box.y).toBeGreaterThan(200); expect(box.y + box.height).toBeLessThan(650);
    await input.evaluate((element) => { (window as unknown as { migrationEditor: Element }).migrationEditor = element; });
    for (const mode of ['浅色', '深色']) {
      await openSpaceSettings(page); await page.getByRole('tab', { name: '通用', exact: true }).click();
      await page.getByRole('radio', { name: mode, exact: true }).focus();
      await page.getByRole('radio', { name: mode, exact: true }).press('Space');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`new-chat-${mode === '浅色' ? 'light' : 'dark'}.png`) });
    }
    await input.fill('界面迁移验证'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[a-f0-9-]+$/); id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    expect(await input.evaluate((element) => element === (window as unknown as { migrationEditor: Element }).migrationEditor)).toBe(true);
    await expect(input).toBeFocused(); expect((await composer.boundingBox())!.y).toBeGreaterThan(650);
    await page.screenshot({ path: info.outputPath('conversation-dark.png') });
    await input.fill('保留下一条草稿');
    await page.getByRole('button', { name: '收起侧栏' }).click(); await expect(input).toHaveValue('保留下一条草稿');
    await page.getByRole('button', { name: '打开对话列表' }).click(); await expect(page.getByRole('button', { name: '空间设置' })).toBeVisible();
    await page.getByRole('button', { name: '开启新对话' }).click(); await expect(input).toBeFocused();
    expect(await input.evaluate((element) => element === (window as unknown as { migrationEditor: Element }).migrationEditor)).toBe(true);
    await page.goBack(); await expect(input).toHaveValue('保留下一条草稿');
  } finally { if (id) await page.request.delete(`/api/conversations/${id}`, { headers }); await data.cleanup(); }
});

test('searchable model picker works with keyboard and keeps distinct model identity', async ({ page }) => {
  const data = await fixture(page);
  try {
    await page.goto('/'); await page.getByLabel('消息', { exact: true }).fill('保留草稿');
    await page.getByRole('combobox', { name: '聊天模型' }).click();
    await page.getByRole('combobox', { name: '搜索模型' }).fill('Thinking');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await page.getByRole('combobox', { name: '搜索模型' }).press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toHaveAttribute('data-model-key', JSON.stringify([data.providerId, 'test-model-2']));
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留草稿');
    await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    await chooseChatModel(page, JSON.stringify([data.providerId, 'test-model']));
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toContainText('EverChat Test');
  } finally { await data.cleanup(); }
});

test('settings use vertical desktop tabs, horizontal mobile tabs, persistent draft and fixed close control', async ({ page }, info) => {
  const data = await fixture(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/'); await openSpaceSettings(page);
    const tabs = page.getByRole('tablist', { name: '设置分类' }); await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill(''); await expect(page.getByTestId('settings-save-status')).toContainText('未保存');
    await page.getByRole('button', { name: '关闭设置' }).click(); await openSpaceSettings(page);
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('');
    await page.getByLabel('名称', { exact: true }).fill('UI Test'); await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    await page.screenshot({ path: info.outputPath('settings-desktop.png') });
    await page.setViewportSize({ width: 320, height: 568 }); await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
    await page.getByText('添加模型', { exact: true }).scrollIntoViewIfNeeded();
    await expect.poll(() => page.getByTestId('settings-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '关闭设置' })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.getByRole('button', { name: '关闭设置' }).focus();
    await page.getByTestId('settings-scroll').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('settings-mobile.png') });
  } finally { await data.cleanup(); }
});
