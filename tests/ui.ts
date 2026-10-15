import { expect, type Locator, type Page } from '@playwright/test';

export async function openSpaceSettings(page: Page) {
  const settings = page.getByRole('button', { name: '空间设置', exact: true });
  if (!await settings.isVisible()) await page.getByRole('button', { name: '打开对话列表' }).click();
  await settings.click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
}

export async function messageMenu(message: Locator) {
  await message.getByRole('button', { name: '更多消息操作', exact: true }).click();
}

export async function conversationMenu(page: Page) {
  await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
}
