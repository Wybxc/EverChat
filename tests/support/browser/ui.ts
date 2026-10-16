import { expect,type Locator,type Page } from '@playwright/test';

export async function openSpaceSettings(page: Page) {
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
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
  const capabilities = page.locator('[data-testid="provider-model-row"]').filter({ has: page.getByLabel(`模型 ID ${index}`, { exact: true }) }).locator('details');
  if (!await capabilities.evaluate((node: HTMLDetailsElement) => node.open)) await capabilities.locator('summary').click();
}

export async function openModelAdder(page: Page) {
  const adder = page.locator('details').filter({ has: page.getByLabel('新模型 ID', { exact: true }) });
  if (!await adder.evaluate((node: HTMLDetailsElement) => node.open)) await adder.locator('summary').click();
}

export async function openParameters(page: Page) {
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: '会话参数', exact: true });
  if (await trigger.isVisible()) await trigger.click();
  else { await conversationMenu(page); await page.getByRole('menuitem', { name: '会话参数', exact: true }).click(); }
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '关闭会话参数', exact: true }) });
  for (const group of ['生成参数', '联网工具', '上下文']) {
    const disclosure = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: new RegExp(`^${group}`) }) });
    if (!await disclosure.evaluate((node: HTMLDetailsElement) => node.open)) await disclosure.locator('summary').click();
  }
}

export async function chooseChatModel(page: Page, key: string) {
  await page.getByRole('combobox', { name: '聊天模型', exact: true }).click();
  await page.locator('[role="option"][data-model-key=' + JSON.stringify(key) + ']').click();
}
export async function expectChatModel(page: Page, key: string) {
  await expect(page.getByRole('combobox', { name: '聊天模型', exact: true })).toHaveAttribute('data-model-key', key);
}
