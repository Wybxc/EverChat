import { expect, test } from '@playwright/test';
import { openSpaceSettings } from '../../support/browser/ui';

test('settings tabs use manual keyboard activation and keep selection while moving focus', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/__dev/access/login');
  await page.goto('/');
  await openSpaceSettings(page);
  const list = page.getByRole('tablist', { name: '设置分类' });
  const general = list.getByRole('tab', { name: '通用', exact: true });
  const providers = list.getByRole('tab', { name: '供应商', exact: true });
  await general.focus();
  await general.press('ArrowDown');
  await expect(providers).toBeFocused();
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(providers).toHaveAttribute('aria-selected', 'false');
  await providers.press('Enter');
  await expect(providers).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
  expect(await page.locator('button button').count()).toBe(0);
  expect(errors).toEqual([]);
});
