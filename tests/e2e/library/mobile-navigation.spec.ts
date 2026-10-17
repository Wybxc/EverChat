import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const headers = { Origin: 'http://127.0.0.1:5174' };
async function swipe(page: Page, from: [number, number], to: [number, number], cancel = false) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from[0], y: from[1] }],
  });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from[0] + ((to[0] - from[0]) * step) / 8,
          y: from[1] + ((to[1] - from[1]) * step) / 8,
        },
      ],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: cancel ? 'touchCancel' : 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
  // A cancelled drag still has a non-modal return animation before the next gesture can start.
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-drag');
}
test.beforeEach(async ({ page }) => {
  await page.request.post('/__dev/access/login', { headers });
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
});

test('touch swipes preview and commit the sidebar; vertical, short and cancelled gestures leave it closed', async ({
  page,
}) => {
  const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
  await swipe(page, [24, 280], [28, 400]);
  await expect(panel).toHaveCount(0);
  await swipe(page, [24, 280], [45, 280]);
  await expect(panel).toHaveCount(0);
  await swipe(page, [24, 280], [200, 280], true);
  await expect(panel).toHaveCount(0);
  await swipe(page, [24, 280], [210, 280]);
  await expect(panel).toBeVisible();
  await swipe(page, [260, 400], [60, 400]);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开对话列表' })).toBeFocused();
  // A completed drag cannot swallow the next independent button tap.
  await page.getByRole('button', { name: '打开对话列表' }).tap();
  await expect(panel).toBeVisible();
});

test('search closes by a real tap after scrolling, viewport changes and repeated sidebar transitions', async ({
  page,
}) => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await page.request.post('/api/conversations', {
        headers,
        data: { id, title: `移动搜索 ${i}` },
      });
    }
    await page.reload();
    const trigger = page.getByRole('button', { name: '打开对话列表' });
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 400 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await trigger.tap();
      await page.getByRole('button', { name: '全局搜索', exact: true }).tap();
      // Repeated commands while the sidebar exits must not open another focus trap early.
      await page.keyboard.press('ControlOrMeta+k');
      const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
      await expect(dialog.getByRole('combobox')).toBeFocused();
      await dialog.locator('[cmdk-list]').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const close = dialog.getByRole('button', { name: '关闭全局搜索' });
      await expect
        .poll(async () => (await close.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(44);
      const box = await close.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.y).toBeGreaterThanOrEqual(12);
      expect(box!.y + box!.height).toBeLessThan(size.height - 12);
      await close.tap();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  } finally {
    for (const id of ids) await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});
