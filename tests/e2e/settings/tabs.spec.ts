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

test('settings use vertical desktop tabs, horizontal mobile tabs, persistent draft and fixed close control', async ({
  page,
}, info) => {
  const data = await fixture(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openSpaceSettings(page);
    const tabs = page.getByRole('tablist', { name: '设置分类' });
    await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('');
    await expect(page.getByTestId('settings-save-status')).toContainText('未保存');
    await page.getByRole('button', { name: '关闭设置' }).click();
    await openSpaceSettings(page);
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('');
    await page.getByLabel('名称', { exact: true }).fill('UI Test');
    await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    await page.screenshot({ path: info.outputPath('settings-desktop.png') });
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
    await page.getByText('添加模型', { exact: true }).scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.getByTestId('settings-scroll').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '关闭设置' })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.getByRole('button', { name: '关闭设置' }).focus();
    await page.getByTestId('settings-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath('settings-mobile.png') });
  } finally {
    await data.cleanup();
  }
});
