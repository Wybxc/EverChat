import { test, expect } from '@playwright/test';
import type { ProviderSettings } from '../../shared/types';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };

test('provider settings require a session and same-origin writes', async ({ request }) => {
  expect((await request.get('/api/settings/provider')).status()).toBe(401);
  expect((await request.put('/api/settings/provider', { headers, data: {} })).status()).toBe(401);
  expect((await request.put('/api/settings/provider', { data: {} })).status()).toBe(403);
});

test('settings save all protocols, retain keys safely, and share configuration without revealing keys', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const initial = await context.request.get('/api/settings/provider').then((response) => response.json()) as ProviderSettings;
  try {
    for (const provider of ['openai-chat', 'anthropic', 'openai-responses', 'gemini']) {
      await page.getByRole('button', { name: '空间设置', exact: true }).click();
      await page.getByLabel('接口协议').selectOption(provider);
      await page.getByLabel('模型 ID', { exact: true }).fill(`${provider}-test-model`);
      await page.getByLabel('API 密钥', { exact: true }).fill(`test-secret-${provider}`);
      await page.getByLabel('系统提示词').fill('请简洁回答');
      await page.getByLabel('输出上限（Tokens）').fill('512');
      const put = page.waitForResponse((response) => response.url().endsWith('/api/settings/provider') && response.request().method() === 'PUT');
      await page.getByRole('button', { name: '保存供应商设置' }).click();
      const response = await put;
      expect(response.status()).toBe(200);
      expect(await response.text()).not.toContain('test-secret');
      await expect(page.getByRole('status')).toHaveText('已保存');
      await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await page.reload();
      await page.getByRole('button', { name: '空间设置', exact: true }).click();
      await expect(page.getByLabel('接口协议')).toHaveValue(provider);
      await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue(`${provider}-test-model`);
      await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('');
      await page.getByLabel('模型 ID', { exact: true }).fill(`${provider}-updated`);
      await page.getByRole('button', { name: '保存供应商设置' }).click();
      await expect(page.getByRole('status')).toHaveText('已保存');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
    const settings = await context.request.get('/api/settings/provider').then((response) => response.json());
    expect(settings).toMatchObject({ provider: 'gemini', model: 'gemini-updated', hasApiKey: true, maxOutputTokens: 512 });
    expect(settings.apiKey).toBeUndefined();
    expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain('test-secret');
    const databaseContainsSecret = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction('keyval').objectStore('keyval').getAll();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        return JSON.stringify(values).includes('test-secret');
      } finally { database.close(); }
    });
    expect(databaseContainsSecret).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    await expect(page.getByLabel('接口协议')).toHaveValue('gemini');
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/provider-settings-light.png' });
    await page.getByRole('radio', { name: '深色' }).focus();
    await page.getByRole('radio', { name: '深色' }).press('Space');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/provider-settings-dark.png' });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();

    const second = await browser.newContext();
    try {
      expect((await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).status()).toBe(200);
      const otherSettings = await second.request.get('/api/settings/provider').then((response) => response.json());
      expect(otherSettings).toEqual(settings);
      const session = await second.request.get('/api/session').then((response) => response.json());
      expect(session).toMatchObject({ provider: 'gemini', model: 'gemini-updated' });
    } finally { await second.close(); }

    const changedEndpoint = await context.request.put('/api/settings/provider', { headers, data: { ...settings, baseUrl: 'https://different.example/v1' } });
    expect(changedEndpoint.status()).toBe(400);
    const changedProtocol = await context.request.put('/api/settings/provider', { headers, data: { ...settings, provider: 'anthropic' } });
    expect(changedProtocol.status()).toBe(400);
    for (const invalid of [{ maxOutputTokens: 0 }, { provider: 'unknown' }, { baseUrl: 'http://untrusted.example' }, { apiKey: 'key\nheader' }]) {
      const response = await context.request.put('/api/settings/provider', { headers, data: { ...settings, ...invalid } });
      expect(response.status()).toBe(400);
    }
    expect(await context.request.get('/api/settings/provider').then((response) => response.json())).toEqual(settings);
  } finally {
    expect((await context.request.put('/api/settings/provider', { headers, data: initial })).status()).toBe(200);
  }
});
