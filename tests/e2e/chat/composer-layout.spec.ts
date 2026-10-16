import { expect,test,type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
}

test('the composer has a visible focus boundary without stealing focus on load', async ({ page }) => {
  await login(page);
  const editor = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(editor).not.toBeFocused();
  await editor.focus();
  const outline = await page.getByTestId('chat-composer').evaluate((node) => {
    const style = getComputedStyle(node); return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline).toEqual({ width: '2px', style: 'solid' });
});

test('a narrow viewport keeps long model names, reasoning controls and send/stop in one toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  const original = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const id = crypto.randomUUID();
  try {
    expect((await page.request.put('/api/settings/providers', { headers, data: {
      ...original, providers: [{ id, name: '测试供应商', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'test-model', name: '一个很长的模型显示名用于验证窄屏仍然可以发送消息', enabled: true, reasoningSupport: 'supported' }] }], activeProviderId: id, activeModel: 'test-model',
    } })).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel('思维强度', { exact: true })).toBeVisible();
    const composer = await page.getByTestId('chat-composer').boundingBox();
    expect(composer!.height).toBeLessThanOrEqual(144);
    await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
    const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(320);
    const toolbar = page.getByTestId('composer-toolbar');
    for (const control of await toolbar.locator('button:visible, select:visible').all()) {
      const box = await control.boundingBox();
      expect(Math.abs(box!.y - send!.y)).toBeLessThanOrEqual(2);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByLabel('消息', { exact: true }).fill('布局检查');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const stop = page.getByRole('button', { name: '停止生成', exact: true });
    await expect(stop).toBeVisible();
    expect((await page.getByTestId('message-viewport').boundingBox())!.height).toBeGreaterThanOrEqual(300);
    const stopping = await stop.boundingBox();
    expect(stopping!.x).toBe(send!.x); expect(stopping!.width).toBe(send!.width);
    await stop.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const title = await page.getByTestId('conversation-title').boundingBox();
    const more = await page.getByRole('button', { name: '更多会话操作' }).boundingBox();
    expect(title!.x + title!.width).toBeLessThanOrEqual(more!.x);
  } finally {
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});
