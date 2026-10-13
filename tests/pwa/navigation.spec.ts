import { test, expect } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000101';
test('production PWA restores a conversation URL offline without caching API responses', async ({ page, context }) => {
  await page.goto(`/c/${id}`);
  await expect(page.getByTestId('user-message')).toContainText('离线 URL 验证');
  await expect(page.getByTestId('assistant-message')).toContainText('已保存的正文');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state)).toBe('activated');
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), `everchat:snapshot:${id}`)).toBe(true);
  // The first document predates installation; its next navigation is controlled by the active worker.
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveURL(`/c/${id}`);
  await expect(page.getByTestId('user-message')).toContainText('离线 URL 验证');
  await expect(page.getByTestId('assistant-message')).toContainText('已保存的正文');
  await expect(page.getByTestId('message-reasoning')).toContainText('已保存的思考');
  await expect(page.getByRole('status')).toContainText('离线');
  expect(await page.evaluate(async () => { try { await fetch('/api/session'); return 'cached'; } catch { return 'offline'; } })).toBe('offline');
  const other = await context.newPage();
  await other.goto(`/c/${id}`);
  await expect(other.getByTestId('user-message')).toContainText('离线 URL 验证');
  await expect(other.getByTestId('assistant-message')).toContainText('已保存的正文');
  await other.close();
  await context.setOffline(false);
});
