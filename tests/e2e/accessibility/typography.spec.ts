import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings, providerDetails } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function fixture(page: Page) {
  expect(
    (await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok(),
  ).toBe(true);
  const original = (await page.request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const provider = crypto.randomUUID(),
    id = crypto.randomUUID();
  expect(
    (
      await page.request.put('/api/settings/providers', {
        headers,
        data: {
          ...original,
          activeProviderId: provider,
          activeModel: 'test-model',
          systemPrompt: '',
          maxOutputTokens: null,
          showReasoning: true,
          providers: [
            {
              id: provider,
              name: '紧凑布局',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: 'test-model',
                  name: 'test-model',
                  enabled: true,
                  reasoningSupport: 'supported',
                },
                { id: 'second-model', name: '备用模型', enabled: true },
              ],
            },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post('/api/conversations', {
        headers,
        data: { id, title: '紧凑布局回归' },
      })
    ).status(),
  ).toBe(201);
  return {
    id,
    cleanup: async () => {
      await page.close();
      await page.request.delete(`/api/conversations/${id}`, { headers });
      expect(
        (await page.request.put('/api/settings/providers', { headers, data: original })).ok(),
      ).toBe(true);
    },
  };
}

async function settingsTab(page: Page, name: string) {
  const tab = page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('tab', { name, exact: true });
  await tab.focus();
  await tab.press('Space');
}

test('font changes resize an existing draft and browser default font preferences keep navigation aligned and controls reachable', async ({
  page,
  context,
}) => {
  const source = await fixture(page);
  const cdp = await context.newCDPSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const editor = page.getByLabel('消息', { exact: true });
    await editor.fill('第一行\n第二行\n第三行');
    let before = (await editor.boundingBox())!.height;
    for (const size of [20, 24]) {
      await page.evaluate((value) => {
        document.documentElement.style.fontSize = `${value}px`;
      }, size);
      await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(before);
      await expect
        .poll(() => editor.evaluate((node) => node.scrollHeight - node.clientHeight))
        .toBeLessThanOrEqual(2);
      before = (await editor.boundingBox())!.height;
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    for (const size of [20, 24]) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: size, fixed: size } });
      // Load with browser font preferences; CDP does not deliver live media-query change events.
      await page.reload();
      await expect(editor).toBeVisible();
      await expect(page.locator('html')).toHaveCSS('font-size', `${size}px`);
      const desktop = await page.evaluate(() => matchMedia('(min-width: 64rem)').matches);
      expect(desktop).toBe(1280 >= size * 64);
      if (desktop)
        await expect(page.getByRole('complementary', { name: '对话列表' })).toBeVisible();
      else {
        await expect(page.getByRole('complementary', { name: '对话列表' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '打开对话列表' })).toBeVisible();
      }
      await page.setViewportSize({ width: 320, height: 568 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      for (const name of ['聊天模型', '思维强度', '发送消息'])
        await expect(page.getByLabel(name, { exact: true })).toBeInViewport({ ratio: 1 });
      await openSpaceSettings(page);
      await settingsTab(page, '供应商');
      await providerDetails(page);
      await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport({
        ratio: 1,
      });
      for (const name of ['名称', 'API 类型', 'API 端点', 'API 密钥']) {
        await page
          .getByLabel(name, { exact: true })
          .evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await expect(page.getByLabel(name, { exact: true })).toBeInViewport({ ratio: 1 });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
    expect(errors).toEqual([]);
  } finally {
    await cdp.detach();
    await source.cleanup();
  }
});
