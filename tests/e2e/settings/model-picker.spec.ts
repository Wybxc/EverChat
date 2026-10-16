import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { chooseChatModel } from '../../support/browser/ui';

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

test('searchable model picker works with keyboard and keeps distinct model identity', async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('保留草稿');
    await page.getByRole('combobox', { name: '聊天模型' }).click();
    await page.getByRole('combobox', { name: '搜索模型' }).fill('Thinking');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await page.getByRole('combobox', { name: '搜索模型' }).press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toHaveAttribute(
      'data-model-key',
      JSON.stringify([data.providerId, 'test-model-2']),
    );
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留草稿');
    await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    await chooseChatModel(page, JSON.stringify([data.providerId, 'test-model']));
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toContainText('EverChat Test');
  } finally {
    await data.cleanup();
  }
});
