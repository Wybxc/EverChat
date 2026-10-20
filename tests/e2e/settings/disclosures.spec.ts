import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import {
  openModelAdder,
  openParameters,
  openSpaceSettings,
  providerDetails,
} from '../../support/browser/ui';

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

const isOpen = (details: Locator) => details.evaluate((node: HTMLDetailsElement) => node.open);

const group = (dialog: Locator, title: string) =>
  dialog.locator('details').filter({
    has: dialog
      .page()
      .locator('summary')
      .filter({ hasText: new RegExp(`^${title}`) }),
  });

async function settingsTab(page: Page, name: string) {
  const tab = page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('tab', { name, exact: true });
  await tab.focus();
  await tab.press('Space');
}

test('model disclosures preserve drafts and focus, remember capabilities within the window, and expose invalid fields', async ({
  page,
}) => {
  const source = await fixture(page);
  try {
    await page.goto('/');
    await openSpaceSettings(page);
    await settingsTab(page, '供应商');
    await providerDetails(page);
    const rows = page.getByTestId('provider-model-row');
    await expect(rows.first()).toHaveText('test-model');
    await expect(page.getByLabel('新模型 ID', { exact: true })).not.toBeVisible();
    await openModelAdder(page);
    const draft = page.getByLabel('新模型 ID', { exact: true });
    const adder = page.locator('details').filter({ has: draft });
    await expect(draft).toBeFocused();
    await draft.fill('unsent-model');
    await adder.locator('summary').click();
    await expect(draft).not.toBeVisible();
    await settingsTab(page, '对话');
    await settingsTab(page, '供应商');
    await openModelAdder(page);
    await expect(draft).toHaveValue('unsent-model');
    await draft.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(rows).toHaveCount(2);
    await page.getByRole('button', { name: '取消添加', exact: true }).click();
    await expect(adder.locator('summary')).toBeFocused();
    await openModelAdder(page);
    await expect(draft).toHaveValue('');
    await adder.locator('summary').click();

    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    const capability = group(rows.first(), '模型能力');
    await expect.poll(() => isOpen(capability)).toBe(false);
    await expect(page.getByLabel('模型 ID 1', { exact: true })).toBeVisible();
    await capability.locator('summary').click();
    const limit = page.getByLabel('上下文窗口（Tokens） 1', { exact: true });
    await limit.fill('0');
    await expect(limit).toBeFocused();
    await expect(limit).toHaveAttribute('aria-invalid', 'true');
    await capability.locator('summary').click();
    await expect.poll(() => isOpen(capability)).toBe(true);
    await expect(capability.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('settings-save-status')).toContainText('未保存');
    await limit.fill('32768');
    await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
    await expect(capability.locator('summary')).toContainText('自定义');
    await page.getByRole('button', { name: '模型设置 2', exact: true }).click();
    await expect.poll(() => isOpen(group(rows.nth(1), '模型能力'))).toBe(false);
    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    await expect.poll(() => isOpen(capability)).toBe(true);
    await settingsTab(page, '通用');
    await settingsTab(page, '供应商');
    await expect.poll(() => isOpen(capability)).toBe(true);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await openSpaceSettings(page);
    await providerDetails(page);
    await page.getByRole('button', { name: '模型设置 1', exact: true }).click();
    await expect.poll(() => isOpen(capability)).toBe(false);
  } finally {
    await source.cleanup();
  }
});

for (const width of [1280, 390])
  test(`conversation parameter tabs retain drafts and expose errors at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    const source = await fixture(page);
    try {
      await page.route('**/api/settings/web-tools', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"test unavailable"}',
        }),
      );
      await page.goto(`/c/${source.id}`);
      await openParameters(page);
      const dialog = page.getByRole('dialog', { name: '会话参数', exact: true });
      const tabs = dialog.getByRole('tablist', { name: '会话参数分类', exact: true });
      await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
      await expect(tabs.getByRole('tab')).toHaveText(['常规', '上下文', '联网']);
      expect(
        await tabs.evaluate((el) =>
          [...el.children].every(
            (child) => child.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom,
          ),
        ),
      ).toBe(true);
      await expect(dialog.locator('details, summary')).toHaveCount(0);
      await expect(dialog.getByRole('tab', { name: '常规', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await dialog.getByLabel('提示词预设', { exact: true }).selectOption('custom');
      await dialog.getByLabel('会话系统提示词', { exact: true }).fill('切换分类仍保留的提示词');
      await dialog.getByRole('tab', { name: '上下文', exact: true }).click();
      await dialog.getByLabel('输出预算方式', { exact: true }).selectOption('custom');
      const limit = dialog.getByLabel('输出 Token 预算', { exact: true });
      await limit.fill('0');
      await expect(limit).toBeFocused();
      await expect(limit).toHaveAttribute('aria-invalid', 'true');
      await expect(dialog.getByRole('alert').filter({ hasText: '请检查参数' })).toBeVisible();
      await dialog.getByRole('tab', { name: '联网', exact: true }).click();
      await expect(dialog.getByText('无法读取联网服务配置。', { exact: true })).toBeVisible();
      await expect(
        dialog.getByText('开启后可能增加搜索服务与模型费用。每个新对话默认关闭。', { exact: true }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: '查看错误', exact: true }).click();
      await expect(dialog.getByRole('tab', { name: '上下文', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(limit).toBeFocused();
      await limit.fill('64');
      await dialog.getByLabel('自动压缩历史', { exact: true }).check();
      await expect(dialog.getByTestId('conversation-save-status')).toHaveText('已保存');
      await dialog.getByLabel('自动压缩阈值（%）', { exact: true }).fill('70');
      await expect(dialog.getByTestId('conversation-save-status')).toHaveText('已保存');
      await dialog.getByTestId('conversation-settings-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(
        dialog.getByRole('button', { name: '关闭会话参数', exact: true }),
      ).toBeInViewport();
      await expect(dialog.getByRole('button', { name: '恢复继承', exact: true })).toBeInViewport();
      await expect(
        dialog.getByText('开启后会额外调用摘要模型，产生供应商费用。原始消息保留。', {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: `test-results/conversation-context-tabs-${width}.png`,
        animations: 'disabled',
      });
      await dialog.getByRole('tab', { name: '常规', exact: true }).click();
      await expect(dialog.getByLabel('会话系统提示词', { exact: true })).toHaveValue(
        '切换分类仍保留的提示词',
      );
      const general = dialog.getByRole('tab', { name: '常规', exact: true });
      await general.focus();
      await general.press('ArrowRight');
      await expect(dialog.getByRole('tab', { name: '上下文', exact: true })).toBeFocused();
      await expect(dialog.getByLabel('输出 Token 预算', { exact: true })).toHaveValue('64');
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.getByRole('button', { name: '关闭会话参数', exact: true }).click();
      await openParameters(page);
      await expect(dialog.getByRole('tab', { name: '常规', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.screenshot({
        path: `test-results/conversation-general-tabs-${width}.png`,
        animations: 'disabled',
      });
      await dialog.getByRole('button', { name: '关闭会话参数', exact: true }).click();
      await openSpaceSettings(page);
      await settingsTab(page, '对话');
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      const title = settings.getByRole('region', { name: '自动标题', exact: true });
      await expect(title.getByLabel('标题模型', { exact: true })).toBeVisible();
      await expect(title.locator('details, summary')).toHaveCount(0);
      await page.screenshot({
        path: `test-results/automatic-title-section-${width}.png`,
        animations: 'disabled',
      });
    } finally {
      await source.cleanup();
    }
  });
