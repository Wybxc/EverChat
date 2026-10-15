import { expect, type Locator, type Page } from '@playwright/test';

export async function openSpaceSettings(page: Page) {
  const settings = page.getByRole('button', { name: '空间设置', exact: true });
  if (!await settings.isVisible() || await settings.evaluate((node) => Boolean(node.closest('[inert]')))) await page.getByRole('button', { name: '打开对话列表' }).click();
  await settings.click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
}

export async function messageMenu(message: Locator) {
  await message.getByRole('button', { name: '更多消息操作', exact: true }).click();
}

export async function conversationMenu(page: Page) {
  await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
}

export async function providerDetails(page: Page) {
  const panel = page.locator('#settings-panel-providers');
  if (!await panel.getByLabel('名称', { exact: true }).isVisible()) {
    const current = panel.locator('button[aria-current="true"]');
    if (await current.count()) await current.click();
  }
}

export async function editModel(page: Page, index = 1) {
  const toggle = page.getByRole('button', { name: `模型设置 ${index}`, exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openParameters(page: Page) {
  const trigger = page.getByRole('button', { name: '会话参数', exact: true });
  if (!await trigger.isVisible()) await conversationMenu(page);
  await trigger.click();
  const context = page.getByText('上下文预算与条数', { exact: true });
  if (await context.locator('..').getAttribute('open') === null) await context.click();
}
