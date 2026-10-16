import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function fixture(page: Page) {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  await page.request.put('/api/settings/providers', {
    headers,
    data: {
      ...original,
      showReasoning: true,
      activeProviderId: providerId,
      activeModel: 'test-model',
      providers: [
        {
          id: providerId,
          name: 'UI Test',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [
            {
              id: 'test-model',
              name: 'EverChat Test',
              enabled: true,
              reasoningSupport: 'supported',
            },
            {
              id: 'test-model-2',
              name: 'Thinking Test',
              enabled: true,
              reasoningSupport: 'supported',
            },
          ],
        },
      ],
    },
  });
  return {
    providerId,
    cleanup: async () => {
      await page.request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('centered new chat keeps its composer, draft and focus when sending and navigating', async ({
  page,
}, info) => {
  const data = await fixture(page);
  let id = '';
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const composer = page.getByTestId('chat-composer'),
      input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.width).toBeCloseTo(776);
    expect(box.y).toBeGreaterThan(200);
    expect(box.y + box.height).toBeLessThan(650);
    await input.evaluate((element) => {
      (window as unknown as { migrationEditor: Element }).migrationEditor = element;
    });
    for (const mode of ['浅色', '深色']) {
      await openSpaceSettings(page);
      await page.getByRole('tab', { name: '通用', exact: true }).click();
      await page.getByRole('radio', { name: mode, exact: true }).focus();
      await page.getByRole('radio', { name: mode, exact: true }).press('Space');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`new-chat-${mode === '浅色' ? 'light' : 'dark'}.png`),
      });
    }
    await input.fill('界面迁移验证');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[a-f0-9-]+(?:\?branch=[^#]+)?$/);
    id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    expect(
      await input.evaluate(
        (element) =>
          element === (window as unknown as { migrationEditor: Element }).migrationEditor,
      ),
    ).toBe(true);
    await expect(input).toBeFocused();
    expect((await composer.boundingBox())!.y).toBeGreaterThan(650);
    await page.screenshot({ path: info.outputPath('conversation-dark.png') });
    await input.fill('保留下一条草稿');
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await expect(input).toHaveValue('保留下一条草稿');
    await page.getByRole('button', { name: '打开对话列表' }).click();
    await expect(page.getByRole('button', { name: '空间设置' })).toBeVisible();
    await page.getByRole('button', { name: '开启新对话' }).click();
    await expect(input).toBeFocused();
    expect(
      await input.evaluate(
        (element) =>
          element === (window as unknown as { migrationEditor: Element }).migrationEditor,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(input).toHaveValue('保留下一条草稿');
  } finally {
    if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
    await data.cleanup();
  }
});
