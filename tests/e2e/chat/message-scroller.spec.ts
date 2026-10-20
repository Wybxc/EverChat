import { expect, test } from '@playwright/test';

test('official scroller follows, yields to reading, restores prepends and isolates nested viewports', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/message-scroller.html');
  const viewport = page.getByTestId('outer');
  const gap = () =>
    viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(gap).toBeLessThan(2);
  await page.getByRole('button', { name: 'Stream', exact: true }).click();
  await expect.poll(gap).toBeLessThan(2);
  await page.getByRole('button', { name: 'Third', exact: true }).click();
  const offset = () =>
    viewport
      .locator('[data-message-id="3"]')
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node.parentElement!.parentElement!.getBoundingClientRect().top,
      );
  await expect.poll(offset).toBeCloseTo(12, 0);
  const previousTop = await viewport.evaluate((node) => node.scrollTop);
  await page.getByTestId('inner').evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    node.scrollTop = 20;
  });
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(previousTop);
  await page.getByRole('button', { name: 'Prepend', exact: true }).click();
  await expect.poll(offset).toBeCloseTo(12, 0);
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    node.scrollTop = 100;
  });
  await page.getByRole('button', { name: 'Stream', exact: true }).click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(100);
  await page.getByRole('button', { name: 'Bottom', exact: true }).click();
  await expect.poll(gap).toBeLessThan(2);
  // Reading inside reasoning must not cancel the transcript's live following.
  await page.getByTestId('inner').evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -20 }));
    node.scrollTop = 20;
  });
  await page.getByRole('button', { name: 'Stream', exact: true }).click();
  await expect.poll(gap).toBeLessThan(2);
});
