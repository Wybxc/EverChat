import { expect, test } from '@playwright/test';
const headers = { Origin: 'http://127.0.0.1:5174' };
for (const mobile of [false, true])
  test(`create and revoke share through compact ${mobile ? 'phone' : 'desktop'} dialogs`, async ({
    page,
    context,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 740 });
    const request = context.request;
    await request.post('/__dev/access/login', { headers });
    const previous = await request.get('/api/settings/providers').then((r) => r.json());
    const id = crypto.randomUUID(),
      providerId = crypto.randomUUID();
    try {
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: '界面供应商',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: 'raw-openai-chat', name: '界面模型', enabled: true }],
            },
          ],
          activeProviderId: providerId,
          activeModel: 'raw-openai-chat',
          systemPrompt: '',
          maxOutputTokens: null,
        },
      });
      await request.post('/api/conversations', { headers, data: { id, title: '分享界面验证' } });
      const submitted = await request
        .post(`/api/conversations/${id}/messages`, {
          headers,
          data: { requestId: crypto.randomUUID(), parentId: null, content: '请检查分享' },
        })
        .then((r) => r.json());
      await expect
        .poll(() =>
          request
            .get(`/api/conversations/${id}`)
            .then((r) => r.json())
            .then((r) => r.messages.at(-1).status),
        )
        .toBe('completed');
      await page.goto(`/c/${id}?branch=${submitted.assistantId}`);
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '分享当前分支', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '分享当前分支', exact: true });
      await expect(dialog).toBeVisible();
      const publish = dialog.getByRole('button', { name: '生成只读链接', exact: true });
      await expect(publish).toBeEnabled();
      await dialog.getByLabel('分享标题', { exact: true }).fill('可撤销的分享');
      await dialog.getByLabel('包含思考内容', { exact: true }).click();
      await expect(publish).toBeEnabled();
      await dialog.getByLabel('分享有效期', { exact: true }).selectOption('30');
      await dialog.locator('details summary').first().click();
      await dialog.getByText('请检查分享', { exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
      await page.screenshot({
        path: `/tmp/everchat-share-preview-${mobile ? 'phone' : 'desktop'}.png`,
      });
      await publish.click();
      const link = dialog.getByLabel('只读分享链接', { exact: true });
      await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
      const url = new URL(await link.inputValue());
      const shareId = url.pathname.split('/')[2];
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      if (mobile) await page.getByRole('button', { name: '打开对话列表', exact: true }).click();
      await page.getByRole('button', { name: '空间设置', exact: true }).click();
      await page.getByRole('tab', { name: '分享', exact: true }).click();
      const sharedRow = page.locator(`[data-share-id="${shareId}"]`);
      await expect(
        sharedRow.getByRole('heading', { name: '可撤销的分享', exact: true }),
      ).toBeVisible();
      await sharedRow.getByText('链接操作', { exact: true }).click();
      await sharedRow.getByRole('button', { name: '撤销分享', exact: true }).click();
      await expect(sharedRow.getByText('已撤销', { exact: true })).toBeVisible();
      expect(
        (
          await request.get(`/public/shares/${url.pathname.split('/')[2]}`, {
            headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
          })
        ).status(),
      ).toBe(404);
      await sharedRow.getByRole('button', { name: '清理快照', exact: true }).click();
      await expect(sharedRow).not.toBeVisible();
      await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport();
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await request.delete(`/api/conversations/${id}`, { headers });
    } finally {
      await request.put('/api/settings/providers', { headers, data: previous });
    }
  });
