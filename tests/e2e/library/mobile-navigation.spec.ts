import { expect, test, type Page } from '@playwright/test';
import { openSpaceSettings } from '../../support/browser/ui';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const headers = { Origin: 'http://127.0.0.1:5174' };
async function swipe(
  page: Page,
  from: [number, number],
  to: [number, number],
  cancel = false,
  duration = 160,
  pause = 0,
) {
  const cdp = await page.context().newCDPSession(page);
  const started = Date.now() / 1000;
  const movementDuration = duration || 60;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    timestamp: started,
    touchPoints: [{ x: from[0], y: from[1] }],
  });
  const steps = duration ? 8 : 3;
  for (let step = 1; step <= steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      timestamp: started + (movementDuration * step) / steps / 1000,
      touchPoints: [
        {
          x: from[0] + ((to[0] - from[0]) * step) / steps,
          y: from[1] + ((to[1] - from[1]) * step) / steps,
        },
      ],
    });
    if (duration) await page.waitForTimeout(duration / steps);
  }
  if (pause) await page.waitForTimeout(pause);
  await cdp.send('Input.dispatchTouchEvent', {
    type: cancel ? 'touchCancel' : 'touchEnd',
    timestamp: started + (movementDuration + pause + 10) / 1000,
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

test('a cold mobile page opens the sidebar with its first touch gesture', async ({ page }) => {
  await swipe(page, [24, 280], [210, 280]);
  await expect(page.getByRole('dialog', { name: '对话列表', exact: true })).toHaveAttribute(
    'data-state',
    'open',
  );
});

test('a fast short flick commits while the same slow movement returns and preserves the draft', async ({
  page,
}) => {
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('手势不能改变草稿');
  const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
  await swipe(page, [24, 280], [98, 280], false, 480);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await expect(input).toHaveValue('手势不能改变草稿');
  await swipe(page, [24, 280], [98, 280], false, 0, 180);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await swipe(page, [24, 280], [98, 280], false, 0);
  await expect(panel).toHaveAttribute('data-state', 'open');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).tap();
  await expect(input).toHaveValue('手势不能改变草稿');
});

test('a second finger and viewport rotation cancel an inert preview and allow the next swipe', async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  const panel = page.locator('[data-sidebar-panel]');
  const begin = async () => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 24, y: 280, id: 1 }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 24 + (46 * step) / 8, y: 280, id: 1 }],
      });
      await page.waitForTimeout(20);
    }
    await expect(page.locator('html')).toHaveAttribute('data-sidebar-drag', 'dragging');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect(panel).toHaveAttribute('inert', '');
    await expect(panel.locator(':focus')).toHaveCount(0);
  };
  try {
    await begin();
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: 70, y: 280, id: 1 },
        { x: 100, y: 350, id: 2 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-drag');
    await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
    await begin();
    await page.setViewportSize({ width: 700, height: 390 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-drag');
    await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  } finally {
    await cdp.detach();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await swipe(page, [24, 280], [210, 280]);
  await expect(panel).toHaveAttribute('data-state', 'open');
});

test('composer input and open settings or search keep their own touch interaction', async ({
  page,
}) => {
  const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('输入控件内不打开侧栏');
  const box = await input.boundingBox();
  const x = Math.max(24, box!.x + 4),
    y = box!.y + box!.height / 2;
  expect(x).toBeLessThanOrEqual(40);
  await swipe(page, [x, y], [210, y]);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await expect(input).toHaveValue('输入控件内不打开侧栏');
  await openSpaceSettings(page);
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const settingsBox = await settings.boundingBox();
  await swipe(page, [24, settingsBox!.y + 70], [210, settingsBox!.y + 70]);
  await expect(settings).toBeVisible();
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).tap();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
  await expect(search).toBeVisible();
  const searchBox = await search.boundingBox();
  await swipe(page, [24, searchBox!.y + 80], [210, searchBox!.y + 80]);
  await expect(search).toBeVisible();
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await search.getByRole('button', { name: '关闭全局搜索', exact: true }).tap();
  await expect(input).toHaveValue('输入控件内不打开侧栏');
});

test('wide code, formulas and tables keep horizontal scrolling and an open menu blocks sidebar gestures', async ({
  page,
}) => {
  const id = crypto.randomUUID();
  try {
    expect(
      (
        await page.request.post('/api/conversations', {
          headers,
          data: { id, title: '侧滑内容边界' },
        })
      ).ok(),
    ).toBe(true);
    const seed = await page.request.post(`/api/__test/conversations/${id}/search-history`, {
      headers,
      data: {},
    });
    const { assistant } = (await seed.json()) as { assistant: string };
    const content = [
      '手势不能抢走已选择的文字',
      '```text\n' + 'long_line_'.repeat(40) + '\n```',
      '$$\n' + Array.from({ length: 50 }, () => 'x').join(' + ') + '\n$$',
      '| ' + 'wide_header_'.repeat(30) + ' | B |\n| --- | --- |\n| value | value |',
    ].join('\n\n');
    const revision = await page.request.patch(`/api/conversations/${id}/messages/${assistant}`, {
      headers,
      data: { requestId: crypto.randomUUID(), content },
    });
    expect(revision.ok()).toBe(true);
    const { messageId } = (await revision.json()) as { messageId: string };
    const path = `/c/${id}?branch=${messageId}`;
    await page.goto(path);
    const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
    for (const selector of ['pre', '.katex-display', 'table']) {
      const block = page.getByTestId('assistant-message').locator(selector);
      await expect(block).toHaveCount(1);
      await block.scrollIntoViewIfNeeded();
      const initial = await block.evaluate((node) => {
        node.scrollLeft = node.scrollWidth - node.clientWidth;
        return node.scrollLeft;
      });
      expect(initial).toBeGreaterThan(100);
      const box = await block.boundingBox();
      const x = Math.max(24, box!.x + 4),
        y = box!.y + box!.height / 2;
      expect(x).toBeLessThanOrEqual(40);
      await swipe(page, [x, y], [210, y]);
      await expect.poll(() => block.evaluate((node) => node.scrollLeft)).toBeLessThan(initial);
      await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
    }
    const selected = page.getByText('手势不能抢走已选择的文字', { exact: true });
    await selected.scrollIntoViewIfNeeded();
    await selected.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '手势不能抢走已选择的文字',
    );
    const selectedBox = await selected.boundingBox();
    await swipe(
      page,
      [24, selectedBox!.y + selectedBox!.height / 2],
      [210, selectedBox!.y + selectedBox!.height / 2],
    );
    await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
    await page.getByRole('button', { name: '更多会话操作', exact: true }).tap();
    await expect(page.getByRole('menu')).toBeVisible();
    await swipe(page, [24, 280], [210, 280]);
    await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
    await expect(page).toHaveURL(path);
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});

test('touch swipes preview and commit the sidebar; vertical, short and cancelled gestures leave it closed', async ({
  page,
}) => {
  const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
  await swipe(page, [24, 280], [28, 400]);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await swipe(page, [24, 280], [45, 280]);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await swipe(page, [24, 280], [200, 280], true);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await swipe(page, [24, 280], [210, 280]);
  await expect(panel).toHaveAttribute('data-state', 'open');
  await swipe(page, [260, 400], [60, 400]);
  await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开对话列表' })).toBeFocused();
  // A completed drag cannot swallow the next independent button tap.
  await page.getByRole('button', { name: '打开对话列表' }).tap();
  await expect(panel).toHaveAttribute('data-state', 'open');
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('first swipe opens and closing restores focus', async ({ page }) => {
    const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
    await swipe(page, [24, 280], [210, 280]);
    await expect(panel).toHaveAttribute('data-state', 'open');
    await swipe(page, [260, 400], [60, 400]);
    await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开对话列表', exact: true })).toBeFocused();
  });
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
      if (size.width === 320) {
        const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
        const list = panel.locator('.overflow-y-auto');
        const box = await list.boundingBox();
        await swipe(page, [24, box!.y + box!.height * 0.8], [26, box!.y + box!.height * 0.2]);
        await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await expect(panel).toHaveAttribute('data-state', 'open');
        const row = panel.getByRole('link').last();
        await row.scrollIntoViewIfNeeded();
        const rowBox = await row.boundingBox();
        const fromX = Math.min(220, rowBox!.x + rowBox!.width - 12);
        expect(
          await row.evaluate(
            (node, point) => document.elementFromPoint(point.x, point.y)?.closest('a') === node,
            { x: fromX, y: rowBox!.y + rowBox!.height / 2 },
          ),
        ).toBe(true);
        await swipe(
          page,
          [fromX, rowBox!.y + rowBox!.height / 2],
          [60, rowBox!.y + rowBox!.height / 2],
        );
        await expect(page.locator('[data-sidebar-panel]')).toHaveCount(0);
        await expect(page).toHaveURL('/');
        await trigger.tap();
      }
      await page.getByRole('button', { name: '全局搜索', exact: true }).tap();
      // Repeated commands while the sidebar exits must not open another focus trap early.
      await page.keyboard.press('ControlOrMeta+k');
      const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
      await expect(dialog.getByRole('combobox')).toBeFocused();
      await dialog.evaluate((node) =>
        Promise.all(
          node
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
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
