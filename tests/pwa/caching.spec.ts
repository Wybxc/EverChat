import { expect, test, type Page, type BrowserContext } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000101';
async function control(page: Page, data: unknown) {
  const response = await page.request.post('/__test/pwa/build', {
    headers: { Origin: 'http://127.0.0.1:5175' },
    data,
  });
  return response.json() as Promise<{ optionalAsset: string }>;
}
async function controlled(page: Page, path = '/') {
  await page.goto(path);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
}
async function cachedPaths(page: Page, kind: 'precache' | 'modules') {
  return page.evaluate(async (kind) => {
    const names = (await caches.keys()).filter(
      (name) =>
        name.startsWith('everchat-static-') &&
        (kind === 'precache' ? name.includes('-precache-') : name.endsWith('-modules')),
    );
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map(({ url }) => new URL(url).pathname),
        ),
      )
    ).flat();
  }, kind);
}
async function clearHttpCache(page: Page, context: BrowserContext, browserName: string) {
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
  }
}
test.beforeEach(async ({ page }) => {
  await control(page, { version: 'a', moduleResponse: 'normal', richMarkdown: false });
});
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await control(page, { moduleResponse: 'normal', richMarkdown: false });
});

test('cold installation only requires the application shell and opens offline while optional modules are unavailable', async ({
  page,
  context,
  browserName,
}) => {
  await control(page, { moduleResponse: 'failure' });
  await controlled(page);
  const paths = await cachedPaths(page, 'precache');
  expect(paths).toContain('/index.html');
  expect(paths.some((path) => /\/index-[\w-]+\.js$/.test(path))).toBe(true);
  expect(paths.some((path) => path.endsWith('.css'))).toBe(true);
  expect(paths.some((path) => /mermaid|pdf|KaTeX|highlighted-body|javascript-/.test(path))).toBe(
    false,
  );
  expect(paths.length).toBeLessThan(20);
  expect(await cachedPaths(page, 'modules')).toEqual([]);
  await page.getByLabel('消息', { exact: true }).fill('冷启动离线草稿');
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('冷启动离线草稿');
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
});

test('used math, syntax highlighting and diagrams survive an offline reload through the module cache', async ({
  page,
  context,
  browserName,
}) => {
  await controlled(page);
  await control(page, { richMarkdown: true });
  const rendered = async () => {
    await expect(page.locator('.katex')).toHaveCount(1);
    await expect(page.locator('pre code span').filter({ hasText: 'cached' }).first()).toBeVisible();
    await page.locator('[data-streamdown="mermaid"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
  };
  await page.goto(`/c/${id}`);
  await rendered();
  await expect
    .poll(async () =>
      (await cachedPaths(page, 'modules')).some(
        (path) => path.includes('KaTeX_Main-Regular') && path.endsWith('.woff2'),
      ),
    )
    .toBe(true);
  const paths = await cachedPaths(page, 'modules');
  expect(paths.some((path) => path.includes('/javascript-'))).toBe(true);
  expect(paths.some((path) => path.includes('/mermaid-'))).toBe(true);
  expect(paths.some((path) => path.includes('/pdf'))).toBe(false);
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  await page.reload();
  await rendered();
  await expect(page.getByTestId('markdown-fallback')).toHaveCount(0);
});

test('authentication HTML, redirects and failures never poison an optional module cache', async ({
  page,
  context,
  browserName,
}) => {
  const { optionalAsset } = await control(page, { moduleResponse: 'normal' });
  await controlled(page);
  for (const mode of ['html', 'redirect', 'failure']) {
    await control(page, { moduleResponse: mode });
    expect(
      await page.evaluate(async (url) => {
        try {
          await fetch(url, { cache: 'no-store' });
          return false;
        } catch {
          return true;
        }
      }, optionalAsset),
    ).toBe(true);
    expect(await cachedPaths(page, 'modules')).not.toContain(optionalAsset);
  }
  await control(page, { moduleResponse: 'normal' });
  expect(
    await page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).ok, optionalAsset),
  ).toBe(true);
  await expect
    .poll(async () => (await cachedPaths(page, 'modules')).includes(optionalAsset))
    .toBe(true);
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  expect(
    await page.evaluate(
      async (url) => (await fetch(url, { cache: 'no-store' })).headers.get('Content-Type'),
      optionalAsset,
    ),
  ).toContain('javascript');
});
