import { expect, test } from '@playwright/test';
const headers = { Origin: 'http://127.0.0.1:5174' };
for (const mobile of [false, true])
  test(`usage filters, pricing, export and dismissal work on ${mobile ? 'phone' : 'desktop'}`, async ({
    page,
    context,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 740 });
    const request = context.request;
    await request.post('/__dev/access/login', { headers });
    const original = await request.get('/api/settings/providers').then((r) => r.json());
    const providerId = crypto.randomUUID(),
      id = crypto.randomUUID(),
      model = 'raw-openai-chat',
      providerName = `UI 用量供应商-${mobile ? '手机' : '桌面'}`;
    try {
      expect(
        (
          await request.put('/api/settings/providers', {
            headers,
            data: {
              providers: [
                {
                  id: providerId,
                  name: providerName,
                  provider: 'openai-chat',
                  baseUrl: 'https://provider.test/v1',
                  apiKey: 'integration-test-key',
                  models: [{ id: model, name: '用量模型', enabled: true }],
                },
              ],
              activeProviderId: providerId,
              activeModel: model,
              systemPrompt: '',
              maxOutputTokens: null,
            },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await request.post('/api/conversations', { headers, data: { id, title: '费用验证' } })
        ).status(),
      ).toBe(201);
      const response = await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: null, content: '账本界面验证' },
      });
      expect(response.status()).toBe(202);
      await expect
        .poll(async () =>
          request
            .get(`/api/usage/report?providerId=${providerId}`)
            .then((r) => r.json())
            .then((r) => r.totals.completed),
        )
        .toBe(1);
      await page.goto('/');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
      if (mobile) await page.getByRole('button', { name: '打开对话列表', exact: true }).click();
      await page.getByRole('button', { name: '用量统计', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '用量统计', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('统计供应商', { exact: true }).selectOption(providerId);
      await expect(dialog.getByText('模型请求／回答', { exact: true })).toBeVisible();
      await dialog.getByRole('tab', { name: '请求', exact: true }).click();
      await expect(dialog.locator('summary')).toContainText(providerName);
      await dialog.locator('summary').click();
      await expect(dialog.getByRole('link', { name: '定位回答' })).toBeVisible();
      await dialog.getByRole('tab', { name: '定价', exact: true }).click();
      const row = dialog
        .locator('div.flex')
        .filter({ hasText: `${providerName} · 用量模型` })
        .last();
      await row.getByRole('button', { name: '配置价格' }).click();
      const editor = page.getByRole('dialog', { name: '模型定价', exact: true });
      await expect(editor).toBeVisible();
      await editor.getByLabel('每百万输入 Token', { exact: true }).fill('2');
      await editor.getByLabel('每百万输出 Token', { exact: true }).fill('8');
      await editor.getByRole('button', { name: '保存价格', exact: true }).click();
      await expect(editor).not.toBeVisible();
      await dialog.getByRole('tab', { name: '请求', exact: true }).click();
      if (!(await dialog.getByRole('button', { name: '按当前价格补算' }).isVisible()))
        await dialog.locator('summary').click();
      await dialog.getByRole('button', { name: '按当前价格补算' }).click();
      await expect(dialog.getByText('CNY 0.000060', { exact: true })).toBeVisible();
      await dialog.getByLabel('修正金额', { exact: true }).fill('0.01');
      await dialog.getByLabel('修正原因', { exact: true }).fill('测试供应商账单修正');
      await dialog.getByRole('button', { name: '保存修正', exact: true }).click();
      await expect(dialog.getByText(/CNY 0\.010000/)).toBeVisible();
      const downloaded = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
      expect((await downloaded).suggestedFilename()).toMatch(/EverChat-usage.*csv/);
      await page.screenshot({ path: `/tmp/everchat-usage-${mobile ? 'phone' : 'desktop'}.png` });
      await page.evaluate(() => {
        document.documentElement.dataset.usageNavigation = 'same-document';
      });
      await dialog.getByRole('link', { name: '定位回答', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/c/${id}\\?branch=`));
      expect(await page.evaluate(() => document.documentElement.dataset.usageNavigation)).toBe(
        'same-document',
      );
    } finally {
      await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    }
  });
