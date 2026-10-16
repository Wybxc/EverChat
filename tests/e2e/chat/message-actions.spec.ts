import { expect, test, type APIRequestContext } from '@playwright/test';
import { messageMenu } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect(
    (await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok(),
  ).toBe(true);
  const id = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: '消息操作测试' } })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post(`/api/__test/conversations/${id}/search-history`, { headers, data: {} })
    ).ok(),
  ).toBe(true);
  return { id, cleanup: () => request.delete(`/api/conversations/${id}`, { headers }) };
}

test('messages can be copied and quoted into the composer while preserving focus', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copiedMessage: string }).copiedMessage = text;
          },
        },
      });
    });
    await page.goto(`/c/${fixture.id}`);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    const user = page.getByTestId('user-message').first();
    const assistant = page.getByTestId('assistant-message').first();
    await expect(page.getByRole('button', { name: '复制消息', exact: true })).toHaveCount(3);
    await expect(page.getByRole('button', { name: '引用消息', exact: true })).toHaveCount(1);
    await user.getByRole('button', { name: '复制消息', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { copiedMessage: string }).copiedMessage),
      )
      .toBe('用户 TARGET 与 [a+b] 😀');
    await assistant.getByRole('button', { name: '复制消息', exact: true }).click();
    const copied = await page.evaluate(
      () => (window as unknown as { copiedMessage: string }).copiedMessage,
    );
    expect(copied).toContain('跨越 **格式** 搜索。');
    expect(copied).not.toContain('末尾思考终点');

    await user.getByRole('button', { name: '引用消息', exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/^> 用户 TARGET 与 \[a\+b\] 😀$/u);

    await editor.fill('请结合下面内容回答：');
    await messageMenu(assistant);
    await page.getByRole('menuitem', { name: '引用消息', exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/^请结合下面内容回答：\n\n> ## 章节/u);
    await expect(editor).toHaveValue(/TARGET 起点/u);
  } finally {
    await fixture.cleanup();
  }
});
