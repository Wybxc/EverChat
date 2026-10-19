import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings, providerDetails } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function fixture(page: Page) {
  expect((await page.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
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
      for (const name of ['聊天模型', '更多参数', '发送消息'])
        await expect(page.getByLabel(name, { exact: true })).toBeInViewport({ ratio: 1 });
      await page.getByRole('button', { name: '更多参数', exact: true }).click();
      await expect(page.getByLabel('思维强度', { exact: true })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
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

test.describe('touch input typography', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('search, model filters and form controls retain a readable font before touch focus', async ({
    page,
  }) => {
    const source = await fixture(page);
    try {
      expect(
        (
          await page.request.post(`/api/__test/conversations/${source.id}/search-history`, {
            headers,
            data: {},
          })
        ).ok(),
      ).toBe(true);
      await page.goto(`/c/${source.id}`);
      const composer = page.getByLabel('消息', { exact: true });
      await composer.fill('触屏字号检查保留草稿');
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      const readable = async (control: Locator, rootSize: number) => {
        await expect(control).toHaveCSS('font-size', `${Math.max(rootSize, 16)}px`);
        await control.tap();
        await expect(control).toBeFocused();
      };
      for (const { width, height, rootSize } of [
        { width: 390, height: 844, rootSize: 16 },
        { width: 844, height: 390, rootSize: 16 },
        { width: 390, height: 844, rootSize: 12 },
        { width: 390, height: 844, rootSize: 20 },
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = `${size}px`;
        }, rootSize);
        await readable(composer, rootSize);
        await page.keyboard.press('ControlOrMeta+k');
        const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
        await readable(search.getByRole('combobox'), rootSize);
        if (rootSize === 16)
          await page.screenshot({ path: `/tmp/everchat-touch-search-${width}.png` });
        await search.getByRole('button', { name: '关闭全局搜索', exact: true }).tap();
        await expect(search).toHaveCount(0);
        await page.getByRole('combobox', { name: '聊天模型', exact: true }).tap();
        const modelSearch = page.getByRole('combobox', { name: '搜索模型', exact: true });
        await readable(modelSearch, rootSize);
        await modelSearch.press('Escape');
        await expect(modelSearch).toHaveCount(0);
        await page.getByRole('button', { name: '搜索当前对话', exact: true }).tap();
        const conversationSearch = page.getByRole('textbox', { name: '查找当前对话', exact: true });
        await readable(conversationSearch, rootSize);
        await conversationSearch.press('Escape');
        await expect(conversationSearch).toHaveCount(0);
        await expect(composer).toHaveValue('触屏字号检查保留草稿');
      }
      await openSpaceSettings(page);
      await settingsTab(page, '预设');
      await readable(page.getByLabel('预设系统提示词', { exact: true }), 20);
      await settingsTab(page, '供应商');
      await providerDetails(page);
      await readable(page.getByLabel('名称', { exact: true }), 20);
      const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(viewport).not.toMatch(/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i);
    } finally {
      await source.cleanup();
    }
  });
});
