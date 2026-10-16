import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
}

test('the unified conversation menu supports keyboard access, bounded scrolling and focus return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  const trigger = page.getByRole('button', { name: '更多会话操作' });
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '会话参数', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: '导入备份', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('menuitem', { name: '会话参数', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '新对话参数' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: '关闭会话参数' }).click();
  await expect(trigger).toBeFocused();
});
