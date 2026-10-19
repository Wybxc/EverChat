import { expect, test } from '@playwright/test';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('switching language preserves URL, draft, dialog and focus, persists locally and synchronizes tabs', async ({
  page,
  context,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID();
  await page.request.post('/api/conversations', {
    headers,
    data: { id, title: 'Do not translate 你好' },
  });
  try {
    await page.goto(`/c/${id}`);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Keep my draft 原文');
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    const language = page.getByRole('combobox', { name: '语言', exact: true });
    await language.focus();
    let navigations = 0,
      writes = 0;
    page.on('framenavigated', () => navigations++);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
        writes++;
    });
    await language.selectOption('en');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveURL(`/c/${id}`);
    expect(navigations).toBe(0);
    expect(writes).toBe(0);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Keep my draft 原文',
    );
    await expect(
      page.getByRole('link', { name: 'Do not translate 你好', exact: true }),
    ).toBeVisible();
    const other = await context.newPage();
    await other.goto(`/c/${id}`);
    await expect(other.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
    await expect(other.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
    await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(other).toHaveURL(`/c/${id}`);
    await other.close();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.reload();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
      'Keep my draft 原文',
    );
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});

test('system language follows browser changes while an explicit choice stays fixed', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-GB'] });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('system');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('system');
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.evaluate(() => window.dispatchEvent(new Event('languagechange')));
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});
