import { test, expect } from '@playwright/test';
import type { ProviderSettings } from '../../shared/types';
import { editModel, openSpaceSettings } from '../ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('mobile settings browse 200 compact models, mount one editor, preserve edits and confirm deletion', async ({ page }) => {
  await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
  const initial = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const id = crypto.randomUUID();
  try {
    expect((await page.request.put('/api/settings/providers', { headers, data: {
      ...initial, activeProviderId: id, activeModel: 'model-0',
      providers: [{ id, name: '大模型列表', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: Array.from({ length: 200 }, (_, index) => ({ id: `model-${index}`, name: `模型 ${index}`, enabled: index === 0 })) }],
    } })).ok()).toBe(true);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/'); await openSpaceSettings(page);
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    const providers = dialog.getByRole('tab', { name: '供应商', exact: true });
    await providers.focus(); await providers.press('Space');
    await expect(page.getByLabel('名称', { exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: '大模型列表', exact: false }).click();
    await expect(page.getByRole('button', { name: '供应商列表', exact: true })).toBeFocused();
    await expect(page.getByTestId('provider-model-row')).toHaveCount(200);
    await expect(page.locator('input[aria-label^="模型 ID"]')).toHaveCount(0);
    await page.getByLabel('筛选模型').fill('model-199');
    await expect(page.getByTestId('provider-model-row')).toHaveCount(1);
    await page.getByLabel('启用模型 模型 199', { exact: true }).check();
    await editModel(page, 200);
    await expect(page.locator('input[aria-label^="模型 ID"]')).toHaveCount(1);
    await page.getByLabel('模型显示名 200', { exact: true }).fill('已自定义');
    await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    const saved = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
    expect(saved.providers[0].models[199]).toMatchObject({ id: 'model-199', name: '已自定义', enabled: true });
    await page.getByRole('button', { name: '删除模型 已自定义', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: '删除模型', exact: true });
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    expect((await page.request.get('/api/settings/providers').then((response) => response.json())).providers[0].models).toHaveLength(200);
    await page.getByRole('button', { name: '删除模型 已自定义', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    expect((await page.request.get('/api/settings/providers').then((response) => response.json())).providers[0].models).toHaveLength(199);
    await page.getByRole('button', { name: '供应商列表', exact: true }).click();
    await expect(page.getByRole('button', { name: '大模型列表', exact: false })).toBeFocused();
    await expect(page.getByLabel('名称', { exact: true })).not.toBeVisible();
    const web = dialog.getByRole('tab', { name: '联网', exact: true });
    await web.focus(); await web.press('Space'); await expect(web).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await page.close();
    await page.request.put('/api/settings/providers', { headers, data: initial });
  }
});
