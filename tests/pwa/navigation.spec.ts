import { test, expect } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000101';
test('production PWA restores a conversation URL offline without caching API responses', async ({ page, context }) => {
  await page.goto(`/c/${id}`);
  await expect(page.getByTestId('user-message')).toContainText('离线 URL 验证');
  await expect(page.getByTestId('assistant-message')).toContainText('已保存的正文');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state)).toBe('activated');
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), `everchat:snapshot:parts-v1:${id}`)).toBe(true);
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
  await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
  const search = page.getByRole('search', { name: '当前对话搜索', exact: true });
  await search.getByRole('textbox', { name: '查找当前对话', exact: true }).fill('已保存的');
  await expect(search.getByRole('status')).toContainText('1 / 2');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    const contrast = await page.evaluate(() => {
      const range = CSS.highlights.get('everchat-search')!.values().next().value as Range;
      const style = getComputedStyle(range.startContainer.parentElement!, '::highlight(everchat-search)');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const luminance = (color: string) => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const bytes = context.getImageData(0, 0, 1, 1).data;
        if (bytes[3] !== 255) throw new Error('Search highlight must have an opaque background and foreground');
        const channels = [...bytes].slice(0, 3).map((byte) => { const value = byte / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const background = luminance(style.backgroundColor), foreground = luminance(style.color);
      return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
  await search.getByRole('button', { name: '关闭对话搜索' }).click();
  const other = await context.newPage();
  await other.goto(`/c/${id}`);
  await expect(other.getByTestId('user-message')).toContainText('离线 URL 验证');
  await expect(other.getByTestId('assistant-message')).toContainText('已保存的正文');
  await other.close();
  await context.setOffline(false);
});
