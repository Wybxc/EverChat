import { expect, test } from '@playwright/test';

test('Cloudflare HTML canonicalization breaks precaching; the deployed routing setting installs and updates without redirects', async ({
  browser,
  request,
}) => {
  for (const [port, status] of [
    [5178, 307],
    [5179, 200],
  ] as const) {
    const origin = `http://127.0.0.1:${port}`;
    const index = await request.get(`${origin}/index.html?__WB_REVISION__=diagnostic`, {
      maxRedirects: 0,
    });
    expect(index.status()).toBe(status);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // Retain the initial object to verify the exact failure chain that Safari reported.
      await page.addInitScript(() => {
        const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = async (...args) => {
          const registration = await register(...args);
          (window as unknown as { registration: ServiceWorkerRegistration }).registration =
            registration;
          return registration;
        };
      });
      await page.goto(origin);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as unknown as { registration?: ServiceWorkerRegistration }).registration,
            ),
          ),
        )
        .toBe(true);
      if (port === 5178) {
        await expect
          .poll(() =>
            page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
          )
          .toBe(0);
        const error = await page.evaluate(async () => {
          try {
            await (
              window as unknown as { registration: ServiceWorkerRegistration }
            ).registration.update();
            return '';
          } catch (error) {
            return (error as Error).name;
          }
        });
        expect(error).toBe('InvalidStateError');
      } else {
        await expect
          .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
          .toBe('activated');
        expect(
          await page.evaluate(async () => {
            await (await navigator.serviceWorker.getRegistration('/'))!.update();
            return true;
          }),
        ).toBe(true);
        for (const path of ['/', '/c/00000000-0000-4000-8000-000000000101'])
          expect((await request.get(`${origin}${path}`)).status()).toBe(200);
      }
    } finally {
      await context.close();
    }
  }
});
