import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
}

test('mobile sidebar contains keyboard focus and returns it without opening the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const sidebar = page.getByRole('dialog', { name: '对话列表' }),
    trigger = page.getByRole('button', { name: '打开对话列表' });
  await expect(sidebar).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('Tab');
  await expect(trigger).not.toBeFocused();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '对话列表' })).toBeVisible();
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await sidebar.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole('complementary', { name: '对话列表' })).toBeVisible();
});
