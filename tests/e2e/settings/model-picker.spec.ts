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
  const gatewayId = crypto.randomUUID();
  await page.request.put('/api/settings/providers', {
    headers,
    data: {
      ...original,
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
        {
          id: gatewayId,
          name: 'Gateway',
          provider: 'openai-chat',
          baseUrl: 'https://gateway.test/v1',
          apiKey: 'integration-test-key',
          models: [{ id: 'test-model', name: 'EverChat Test', enabled: true }],
        },
      ],
    },
  });
  return {
    providerId,
    gatewayId,
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
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toHaveText(
      'UI Test · Thinking Test',
    );
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留草稿');
    await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    await chooseChatModel(page, JSON.stringify([data.providerId, 'test-model']));
    await expect(page.getByRole('combobox', { name: '聊天模型' })).toHaveText(
      'UI Test · EverChat Test',
    );
  } finally {
    await data.cleanup();
  }
});

for (const width of [375, 1280])
  test(`model picker distinguishes providers, handles empty results and restores focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.emulateMedia({ colorScheme: width === 1280 ? 'dark' : 'light' });
    const data = await fixture(page);
    try {
      await page.goto('/');
      const composer = page.getByLabel('消息', { exact: true });
      const trigger = page.getByRole('combobox', { name: '聊天模型' });
      await composer.fill('保留输入');
      await trigger.click();
      const input = page.getByRole('combobox', { name: '搜索模型' });
      await expect(input).toBeFocused();
      await expect(page.locator('[data-slot=combobox-empty]')).toHaveText('');
      expect((await page.locator('[data-slot=combobox-empty]').boundingBox())!.height).toBe(0);
      await input.fill('test-model');
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(3);
      await input.fill('no-such-model');
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
      await expect(page.getByText('没有匹配的模型', { exact: true })).toBeVisible();
      await input.fill('Gateway');
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
      await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      await expect(input).toBeVisible();
      await input.press('ArrowDown');
      await input.press('Enter');
      await expect(trigger).toHaveAttribute(
        'data-model-key',
        JSON.stringify([data.gatewayId, 'test-model']),
      );
      await expect(trigger).toHaveText('Gateway · EverChat Test');
      await expect(composer).toBeFocused();
      await expect(input).toBeHidden();
      await trigger.click();
      await expect(input).toHaveValue('');
      await page
        .locator(
          '[role="option"][data-model-key=' +
            JSON.stringify(JSON.stringify([data.gatewayId, 'test-model'])) +
            ']',
        )
        .click();
      await expect(composer).toBeFocused();
      await expect(input).toBeHidden();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(input).toBeFocused();
      await input.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(composer).toHaveValue('保留输入');
      await expect(input).toBeHidden();
      await trigger.click();
      await expect(input).toBeFocused();
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(3);
      await page
        .locator('[data-slot=combobox-content]')
        .evaluate((node) =>
          Promise.all(
            node
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
      await page.screenshot({ path: `/tmp/everchat-base-model-${width}.png` });
    } finally {
      await data.cleanup();
    }
  });
