import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function login(page: Page) {
  await page.goto('/');
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
}

test('the composer has a visible focus boundary without stealing focus on load', async ({
  page,
}) => {
  await login(page);
  const editor = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(editor).not.toBeFocused();
  await editor.focus();
  const outline = await page.getByTestId('chat-composer').evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline).toEqual({ width: '2px', style: 'solid' });
});

test('a narrow viewport folds parameters and preserves them across resizing and enlarged text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  const original = (await page.request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const id = crypto.randomUUID();
  try {
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            ...original,
            providers: [
              {
                id,
                name: '测试供应商',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [
                  {
                    id: 'test-model',
                    name: '一个很长的模型显示名用于验证窄屏仍然可以发送消息',
                    enabled: true,
                    reasoningSupport: 'supported',
                    metadataOverrides: { contextWindow: 1000000 },
                  },
                ],
              },
            ],
            activeProviderId: id,
            activeModel: 'test-model',
          },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    const parameters = page.getByRole('button', { name: '更多参数', exact: true });
    await expect(parameters).toBeVisible();
    await expect(page.getByLabel('思维强度', { exact: true })).toHaveCount(0);
    const composer = await page.getByTestId('chat-composer').boundingBox();
    expect(composer!.height).toBeLessThanOrEqual(144);
    await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
    const sendButton = page.getByRole('button', { name: '发送消息', exact: true });
    await expect(sendButton).toBeDisabled();
    await expect(page.getByTestId('chat-composer')).toHaveCSS('opacity', '1');
    const send = await sendButton.boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(320);
    const toolbar = page.getByTestId('composer-toolbar');
    for (const control of await toolbar.locator('button:visible, select:visible').all()) {
      const box = await control.boundingBox();
      expect(Math.abs(box!.y - send!.y)).toBeLessThanOrEqual(2);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await parameters.click();
    await page.getByLabel('思维强度', { exact: true }).selectOption('high');
    await expect(page.getByTestId('context-estimate')).toContainText('上下文估算');
    await page.keyboard.press('Escape');
    await expect(parameters).toBeFocused();
    await expect(parameters).toHaveAttribute('aria-description', /思维：高/);
    const web = page.getByRole('button', { name: '联网搜索', exact: true });
    await expect(web).toBeVisible();
    await web.click();
    await expect(web).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await web.click();
    await expect(web).toHaveAttribute('aria-pressed', 'false');
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(parameters).toHaveCount(0);
    await expect(page.getByLabel('思维强度', { exact: true })).toHaveValue('high');
    const context = page.getByRole('button', { name: '查看上下文估算' });
    await expect(context).toBeVisible();
    await expect(context.locator('[data-slot=progress]')).toBeVisible();
    await expect(context).toHaveAccessibleName('查看上下文估算');
    await expect(context).not.toContainText(/Tokens|%/);
    const indicatorCenter = await context.locator('[data-slot=progress]').evaluate((node) => {
      const indicator = node.getBoundingClientRect(),
        button = node.parentElement!.getBoundingClientRect();
      return Math.max(
        Math.abs(indicator.y + indicator.height / 2 - button.y - button.height / 2),
        Math.abs(indicator.x + indicator.width / 2 - button.x - button.width / 2),
      );
    });
    expect(indicatorCenter).toBeLessThanOrEqual(1);
    expect((await context.boundingBox())!.width).toBe(44);
    await context.click();
    const contextDetails = page.getByRole('dialog', { name: '上下文估算', exact: true });
    await expect(contextDetails).toContainText('<0.01%');
    await expect(contextDetails).toContainText('Tokens');
    await page.keyboard.press('Escape');
    await expect(context).toBeFocused();
    for (const theme of ['light', 'dark']) {
      await page
        .locator('html')
        .evaluate((node, theme) => node.classList.toggle('dark', theme === 'dark'), theme);
      await expect(page.getByTestId('chat-composer')).toHaveCSS('opacity', '1');
      const model = page.getByRole('combobox', { name: '聊天模型', exact: true });
      await page.getByLabel('消息', { exact: true }).fill('颜色检查');
      await expect(sendButton).toBeEnabled();
      await expect
        .poll(() =>
          model.evaluate(
            (node) => getComputedStyle(node).color === getComputedStyle(document.body).color,
          ),
        )
        .toBe(true);
      await page.screenshot({ path: test.info().outputPath(`context-meter-${theme}.png`) });
      await page.getByLabel('消息', { exact: true }).fill('');
      await expect(sendButton).toBeDisabled();
    }
    await page.locator('html').evaluate((node) => node.classList.remove('dark'));
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(parameters).toBeVisible();
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    for (const control of await toolbar.locator('button:visible').all()) {
      await expect(control).toBeInViewport({ ratio: 1 });
      expect((await control.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await parameters.click();
    await expect(page.getByLabel('思维强度', { exact: true })).toHaveValue('high');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '更多参数', exact: true })).toHaveCount(0);
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
    await expect(page.locator('html')).toHaveCSS('font-size', '16px');
    await expect(toolbar).toHaveAttribute('data-compact', 'true');
    await page.screenshot({ path: '/tmp/everchat-composer-320.png' });
    await page.getByLabel('消息', { exact: true }).fill('布局检查');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const stop = page.getByRole('button', { name: '停止生成', exact: true });
    await expect(stop).toBeVisible();
    expect(
      (await page.getByTestId('message-viewport').boundingBox())!.height,
    ).toBeGreaterThanOrEqual(300);
    const stopping = await stop.boundingBox();
    expect(stopping!.x).toBe(send!.x);
    expect(stopping!.width).toBe(send!.width);
    await stop.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const title = await page.getByTestId('conversation-title').boundingBox();
    const more = await page.getByRole('button', { name: '更多会话操作' }).boundingBox();
    expect(title!.x + title!.width).toBeLessThanOrEqual(more!.x);
  } finally {
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});
