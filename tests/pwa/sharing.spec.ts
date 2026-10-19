import { expect, test } from '@playwright/test';
const headers = { Origin: 'http://127.0.0.1:5175' };
test('controlled public shares stay network-only, skip private startup and do not block PWA updates', async ({
  page,
  context,
  request,
}) => {
  await request.post('/__test/pwa/build', {
    headers,
    data: { version: 'a', failSettings: false, moduleResponse: 'normal', richMarkdown: false },
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  const shared = await context.newPage(),
    privateCalls: string[] = [],
    publicCalls: string[] = [];
  shared.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api')) privateCalls.push(req.url());
    if (new URL(req.url()).pathname.startsWith('/public/')) publicCalls.push(req.url());
  });
  await shared.addInitScript(() => {
    navigator.serviceWorker.register = () => {
      throw new Error('Public pages must not register a service worker');
    };
    indexedDB.open = () => {
      throw new Error('Public pages must not open private databases');
    };
  });
  await shared.goto(`/s/${'a'.repeat(22)}#${'b'.repeat(43)}`);
  await expect
    .poll(() => shared.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  const previousCalls = publicCalls.length;
  const response = await shared.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(shared.getByRole('heading', { name: '公开 PWA 快照', exact: true })).toBeVisible();
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  await expect(shared.getByText('全文末尾', { exact: true })).toBeVisible();
  await expect(shared.locator('article')).toHaveCount(4);
  expect(publicCalls.length - previousCalls).toBe(1);
  await expect(shared.getByRole('button', { name: '继续阅读' })).toHaveCount(0);
  const user = shared.getByTestId('user-message').first(),
    thought = shared.getByTestId('assistant-message').first().locator('details');
  await expect(user.locator('.bg-user-message')).toHaveText('公开提问\n第二行');
  expect(await thought.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await thought.locator('summary').click();
  await expect(thought.getByText('公开思考', { exact: true })).toBeVisible();
  await shared.setViewportSize({ width: 390, height: 740 });
  await shared.getByLabel('颜色模式').selectOption('dark');
  expect(await shared.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await shared.screenshot({
    path: `/tmp/everchat-sharing-full-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(privateCalls).toEqual([]);
  expect(
    await shared.evaluate(async () => {
      const paths = (
        await Promise.all(
          (await caches.keys()).map(async (name) =>
            (await (await caches.open(name)).keys()).map((req) => new URL(req.url).pathname),
          ),
        )
      ).flat();
      return paths.some((path) => path.startsWith('/public/') || path.startsWith('/api/'));
    }),
  ).toBe(false);
  await request.post('/__test/pwa/build', { headers, data: { version: 'b' } });
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新应用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更新应用', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await expect(page.getByTestId('app-version')).toHaveText('pwa-test-b');
  // Activation discards old hashed modules. Visit once online to cache the new public entry.
  await shared.reload();
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  expect(privateCalls).toEqual([]);
  await context.setOffline(true);
  await shared.reload();
  await expect(shared.getByRole('alert')).toContainText('联网后重试');
  await expect(shared.getByText('公开正文', { exact: true })).not.toBeVisible();
  await context.setOffline(false);
  await request.post('/__test/pwa/build', { headers, data: { version: 'a' } });
});
