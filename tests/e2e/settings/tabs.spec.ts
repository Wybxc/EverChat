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

test('autosave uses one nonblocking toast, keeps fields stable, then dismisses success', async ({
  page,
}) => {
  const data = await fixture(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await page.getByRole('button', { name: 'UI Test', exact: false }).click();
    const name = page.getByLabel('名称', { exact: true });
    const status = page.getByTestId('settings-save-status');
    await expect(status).toHaveCount(0);
    const before = await name.boundingBox();
    await page.route('**/api/settings/providers', async (route) => {
      if (route.request().method() === 'PUT') await hold;
      await route.continue();
    });
    await name.fill('第一次修改');
    await expect(status).toHaveText('保存中…');
    await name.fill('最终修改');
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(1);
    await expect(name).toBeFocused();
    expect(await name.boundingBox()).toEqual(before);
    await expect(status).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath('autosave-toast-mobile.png'),
      animations: 'disabled',
    });
    release();
    await expect(status).toHaveText('已保存');
    await expect(name).toBeFocused();
    await expect(status).toHaveCount(0);
    await expect(name).toHaveValue('最终修改');
    expect(
      (await page.request.get('/api/settings/providers').then((r) => r.json())).providers[0].name,
    ).toBe('最终修改');
  } finally {
    release();
    await page.unroute('**/api/settings/providers');
    await data.cleanup();
  }
});

test('failed autosave stays visible across tabs and supports keyboard retry inside the dialog', async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await page.route('**/api/settings/providers', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await route.fulfill({ status: 503, json: { error: '测试保存失败' } });
    });
    await page.getByLabel('名称', { exact: true }).fill('失败后重试');
    const status = page.getByTestId('settings-save-status');
    await expect(status).toContainText('服务暂时不可用');
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await expect(status).toBeVisible();
    await page.waitForTimeout(2800);
    await expect(status).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('autosave-error-toast-dark.png'),
      animations: 'disabled',
    });
    await page.unroute('**/api/settings/providers');
    const retry = page
      .getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expect(status).toHaveText('已保存');
    await expect
      .poll(() =>
        page
          .getByRole('dialog', { name: '设置', exact: true })
          .evaluate((dialog) => dialog.contains(document.activeElement)),
      )
      .toBe(true);
    expect(
      (await page.request.get('/api/settings/providers').then((r) => r.json())).providers[0].name,
    ).toBe('失败后重试');
  } finally {
    await page.unroute('**/api/settings/providers');
    await data.cleanup();
  }
});
