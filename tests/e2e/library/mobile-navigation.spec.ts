import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const headers = { Origin: 'http://127.0.0.1:5174' };
async function swipe(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page);
  const started = Date.now() / 1000;
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      timestamp: started,
      touchPoints: [{ x: from[0], y: from[1] }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        timestamp: started + (160 * step) / 8 / 1000,
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
      type: 'touchEnd',
      timestamp: started + 0.17,
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}
test.beforeEach(async ({ page }) => {
  await page.request.post('/__dev/access/login', { headers });
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
});

test('swiping leaves sidebar state unchanged while its buttons preserve the draft and focus', async ({
  page,
}) => {
  const input = page.getByLabel('消息', { exact: true });
  const trigger = page.getByRole('button', { name: '打开对话列表', exact: true });
  const panel = page.getByRole('dialog', { name: '对话列表', exact: true });
  await input.fill('保留输入草稿');
  for (const x of [24, 80, 104]) {
    await swipe(page, [x, 280], [250, 280]);
    await expect(panel).toHaveCount(0);
  }
  await expect(input).toHaveValue('保留输入草稿');
  await trigger.tap();
  await expect(panel).toHaveAttribute('data-open', '');
  await swipe(page, [200, 280], [60, 280]);
  await expect(panel).toHaveAttribute('data-open', '');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).tap();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue('保留输入草稿');
  await expect(page).toHaveURL('/');
});

test('mobile content keeps native vertical and horizontal scrolling', async ({ page }) => {
  const id = crypto.randomUUID();
  try {
    expect(
      (
        await page.request.post('/api/conversations', {
          headers,
          data: { id, title: '移动内容滚动' },
        })
      ).ok(),
    ).toBe(true);
    const seed = await page.request.post(`/api/__test/conversations/${id}/search-history`, {
      headers,
      data: {},
    });
    const { assistant } = (await seed.json()) as { assistant: string };
    const content = [
      '移动内容滚动检查',
      '```text\n' + 'long_line_'.repeat(40) + '\n```',
      '$$\n' + Array.from({ length: 50 }, () => 'x').join(' + ') + '\n$$',
      '| ' + 'wide_header_'.repeat(30) + ' | B |\n| --- | --- |\n| value | value |',
      ...Array.from({ length: 20 }, (_, i) => `正文滚动段落 ${i}`),
    ].join('\n\n');
    const revision = await page.request.patch(`/api/conversations/${id}/messages/${assistant}`, {
      headers,
      data: { requestId: crypto.randomUUID(), content },
    });
    expect(revision.ok()).toBe(true);
    const { messageId } = (await revision.json()) as { messageId: string };
    const path = `/c/${id}?branch=${messageId}`;
    await page.goto(path);
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
      const x = box!.x + 8,
        y = box!.y + box!.height / 2;
      await swipe(page, [x, y], [x + 130, y]);
      await expect.poll(() => block.evaluate((node) => node.scrollLeft)).toBeLessThan(initial);
      await expect(page.getByRole('dialog', { name: '对话列表', exact: true })).toHaveCount(0);
    }
    const viewport = page.getByTestId('message-viewport');
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
    });
    await swipe(page, [80, 400], [82, 250]);
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('dialog', { name: '对话列表', exact: true })).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
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
        await swipe(page, [80, box!.y + box!.height * 0.8], [82, box!.y + box!.height * 0.2]);
        await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await expect(panel).toHaveAttribute('data-open', '');
        await swipe(page, [200, 200], [60, 200]);
        await expect(panel).toHaveAttribute('data-open', '');
        await page.getByRole('button', { name: '收起侧栏', exact: true }).tap();
        await expect(panel).toHaveCount(0);
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
      await dialog.locator('[data-slot=search-results]').evaluate((node) => {
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
