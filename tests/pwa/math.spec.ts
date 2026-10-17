import { expect, test } from '@playwright/test';

test('production math caches its first use before an offline reload, including real KaTeX fonts', async ({
  page,
  context,
  browserName,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/c/00000000-0000-4000-8000-000000000101');
  await expect(page.locator('.katex')).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state),
    )
    .toBe('activated');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const resources = performance
          .getEntriesByType('resource')
          .map(({ name }) => name)
          .filter((url) => /\/assets\/.*\.(?:js|css|woff2)$/.test(url));
        return (
          resources.length > 0 &&
          (
            await Promise.all(resources.map((url) => caches.match(url, { ignoreSearch: true })))
          ).every(Boolean)
        );
      }),
    )
    .toBe(true);
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
  }
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.katex')).toHaveCount(3);
    await expect(page.locator('.katex-error')).toHaveCount(0);
    const fonts = await page.evaluate(async () => {
      try {
        await document.fonts.load('16px KaTeX_Main');
        await document.fonts.load('italic 16px KaTeX_Math');
      } catch {
        return false;
      }
      return (
        document.fonts.check('16px KaTeX_Main') && document.fonts.check('italic 16px KaTeX_Math')
      );
    });
    expect(fonts).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
