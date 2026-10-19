import { expect, test, type Page } from '@playwright/test';
import { openSpaceSettings } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174';
async function signIn(page: Page) {
  expect((await page.request.post('/__dev/access/login')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}

test('an expired Access response cannot restore cached authentication; reauthentication preserves the URL and draft', async ({
  page,
}) => {
  await signIn(page);
  const id = crypto.randomUUID();
  expect(
    (
      await page.request.post('/api/conversations', {
        headers: { Origin: origin },
        data: { id, title: 'Access 恢复' },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/c/${id}`);
  await page.getByLabel('消息', { exact: true }).fill('重新登录后保留草稿');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('everchat:access-session')))
    .toBeTruthy();
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'text/html',
      body: '<html>Access session expired</html>',
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/session');
  await page.getByRole('button', { name: '重新登录' }).click();
  await expect(page).toHaveURL(`${origin}/c/${id}`);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('重新登录后保留草稿');
  const response = await page.request.get('/auth/resume?returnTo=%2F%2Fevil.invalid', {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe('/');
});

test('offline sign-out clears private records, locks other tabs and offers edge logout after reconnecting', async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.getByLabel('消息', { exact: true }).fill('退出时清除的草稿');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByLabel('消息', { exact: true })).toBeVisible();
  await openSpaceSettings(page);
  await context.setOffline(true);
  for (const tab of [page, other])
    await expect.poll(() => tab.evaluate(() => navigator.onLine)).toBe(false);
  await page.getByRole('button', { name: '退出并清除本地记录' }).click();
  for (const tab of [page, other]) {
    await expect(tab.getByRole('button', { name: '完成退出' })).toBeVisible();
    await expect(tab.getByRole('button', { name: '完成退出' })).toBeDisabled();
    await expect(tab.getByLabel('消息', { exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        tab.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('everchat:'))),
      )
      .toEqual([]);
  }
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '完成退出' })).toBeEnabled();
  // A new visit must remain locked even while the old edge cookie is still present.
  await page.reload();
  await expect(page.getByRole('button', { name: '完成退出' })).toBeVisible();
  await page.getByRole('button', { name: '完成退出' }).click();
  await expect(page).toHaveURL(`${origin}/__dev/access/logout`);
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await other.close();
});
