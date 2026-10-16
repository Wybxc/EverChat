import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';

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

const isOpen = (details: Locator) => details.evaluate((node: HTMLDetailsElement) => node.open);

test('answers use the available narrow width and rich content retains one frame while folded thoughts stay closed after branch selection and reconnect', async ({
  page,
  context,
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
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/c/${source.id}`);
    const answer = page.getByTestId('assistant-message').first();
    const body = answer.locator('[data-search-content$=":content"]');
    expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(280);
    await page.locator('[data-streamdown="mermaid"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
    const frames = await page.locator('pre, [data-streamdown="mermaid"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        let count = 0;
        for (
          let element: Element | null = node;
          element && !element.classList.contains('markdown');
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          if (parseFloat(style.borderTopWidth) > 0) count++;
        }
        return count;
      }),
    );
    expect(frames).toEqual([1, 1]);
    const thought = answer.getByTestId('message-reasoning');
    await expect.poll(() => isOpen(thought)).toBe(true);
    await thought.locator('summary').click();
    await expect.poll(() => isOpen(thought)).toBe(false);
    await answer.getByRole('button', { name: '更多消息操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '从这里继续', exact: true }).click();
    await expect.poll(() => isOpen(thought)).toBe(false);
    await context.setOffline(true);
    await expect(page.getByRole('banner')).toContainText('离线');
    await context.setOffline(false);
    await expect(page.getByRole('banner')).toContainText('已同步');
    await expect.poll(() => isOpen(thought)).toBe(false);
    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await page.getByLabel('查找当前对话', { exact: true }).fill('隐藏目标');
    await expect.poll(() => isOpen(thought)).toBe(true);
    await page.getByLabel('查找当前对话', { exact: true }).press('Escape');
    await expect.poll(() => isOpen(thought)).toBe(true);
  } finally {
    await context.setOffline(false);
    await source.cleanup();
  }
});
