import { expect, test, type Page } from '@playwright/test';

const headers = { Origin: 'http://127.0.0.1:5174' };
const toolbar = (page: Page) => page.getByRole('group', { name: '对话阅读导航', exact: true });
const button = (page: Page, name: string) =>
  toolbar(page).getByRole('button', { name, exact: true });
const pane = (page: Page) => page.getByTestId('message-viewport');
const top = (page: Page) => pane(page).evaluate((node) => node.scrollTop);
const gap = (page: Page) =>
  pane(page).evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
const answer = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
async function offset(page: Page, id: string) {
  return answer(page, id).evaluate((node) => {
    const viewport = node.closest('[data-testid="message-viewport"]')!;
    return node.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
}
async function setup(page: Page) {
  expect((await page.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect(
    (
      await page.request.post('/api/conversations', { headers, data: { id, title: '阅读导航' } })
    ).ok(),
  ).toBe(true);
  const response = await page.request.post(`/api/__test/conversations/${id}/search-history`, {
    headers,
    data: {},
  });
  expect(response.ok()).toBe(true);
  const seeded = (await response.json()) as { user: string; assistant: string; last: string };
  await page.goto(`/c/${id}?branch=${seeded.last}`);
  await expect(toolbar(page)).toBeVisible();
  await expect(page.locator('.katex')).toHaveCount(1);
  return {
    id,
    ...seeded,
    cleanup: () => page.request.delete(`/api/conversations/${id}`, { headers }),
  };
}

test('four buttons navigate actual answer starts, handle clamped ends and keep URL, draft and focus', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setup(page);
  try {
    const url = page.url();
    await page.getByLabel('消息', { exact: true }).fill('导航时保留草稿');
    await button(page, '跳到底部').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await button(page, '跳到顶部').click();
    await expect.poll(() => top(page)).toBe(0);
    await expect(button(page, '上一条回答')).toHaveAttribute('aria-disabled', 'true');
    await button(page, '下一条回答').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => offset(page, fixture.assistant)).toBeCloseTo(12, 0);
    await expect(button(page, '下一条回答')).toBeFocused();
    const box = await pane(page).boundingBox();
    await page.mouse.move(box!.x + 4, box!.y + 100);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => offset(page, fixture.assistant)).toBeLessThan(-100);
    await button(page, '上一条回答').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => offset(page, fixture.assistant)).toBeCloseTo(12, 0);
    await expect(button(page, '上一条回答')).toBeFocused();
    await button(page, '下一条回答').click();
    await expect(toolbar(page).getByRole('status')).toHaveText('已定位第 2 条回答，共 2 条');
    await expect(button(page, '下一条回答')).toHaveAttribute('aria-disabled', 'true');
    await button(page, '下一条回答').press('Space');
    await expect(button(page, '下一条回答')).toBeFocused();
    await button(page, '上一条回答').click();
    await expect.poll(() => offset(page, fixture.assistant)).toBeCloseTo(12, 0);
    // A late font/image-sized change above the selected answer retains its reading position.
    await answer(page, fixture.user).evaluate((node) => {
      node.style.paddingBottom = '100px';
    });
    await expect.poll(() => offset(page, fixture.assistant)).toBeCloseTo(12, 0);
    await button(page, '跳到底部').click();
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await expect(page).toHaveURL(url);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('导航时保留草稿');
    await expect(button(page, '跳到底部')).toBeFocused();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect
        .poll(() => toolbar(page).evaluate((node) => getComputedStyle(node).backgroundColor))
        .toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(21, 21, 23)');
      const previous = button(page, '上一条回答');
      // A theme-triggered layout can scroll and dismiss Radix hints; refocus for this sample.
      await button(page, '跳到底部').focus();
      await previous.focus();
      // Safari's system preference can skip buttons in Tab order; keyboard input still shows focus.
      await previous.press('ArrowRight');
      await expect(previous).toBeFocused();
      const hint = page.getByRole('tooltip', { name: '上一条回答', exact: true });
      await expect(hint).toBeVisible();
      await expect
        .poll(async () => {
          const tip = await hint.boundingBox(),
            nav = await toolbar(page).boundingBox();
          return tip!.x + tip!.width <= nav!.x;
        })
        .toBe(true);
      await expect
        .poll(() =>
          previous.evaluate((node) => {
            const context = document.createElement('canvas').getContext('2d')!;
            const backgroundColor = getComputedStyle(
              node.closest('[role="group"]')!,
            ).backgroundColor;
            const luminance = (color: string) => {
              context.fillStyle = backgroundColor;
              context.fillRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
                const n = value / 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              });
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const style = getComputedStyle(node),
              background = luminance(backgroundColor);
            return Math.min(
              ...[style.color, style.borderColor].map((color) => {
                const foreground = luminance(color);
                return (
                  (Math.max(foreground, background) + 0.05) /
                  (Math.min(foreground, background) + 0.05)
                );
              }),
            );
          }),
        )
        .toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: testInfo.outputPath(`desktop-${theme}.png`) });
    }
  } finally {
    await fixture.cleanup();
  }
});

test.describe('touch layouts', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('mobile navigation stays reachable above the composer, works offline and hides on a new chat', async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await setup(page);
    try {
      await context.setOffline(true);
      for (const size of [
        { width: 320, height: 480, font: 16 },
        { width: 844, height: 390, font: 16 },
        { width: 390, height: 844, font: 32 },
      ]) {
        await page.setViewportSize(size);
        await page.evaluate((font) => {
          document.documentElement.style.fontSize = `${font}px`;
        }, size.font);
        // Resize/font changes settle through the viewport observer; sample both rects together.
        await expect
          .poll(() =>
            toolbar(page).evaluate((node) => {
              const nav = node.getBoundingClientRect();
              const viewport = node
                .parentElement!.querySelector('[data-testid="message-viewport"]')!
                .getBoundingClientRect();
              return (
                nav.width > nav.height &&
                nav.width <= viewport.width - 24 &&
                nav.top >= viewport.top &&
                nav.bottom <= viewport.bottom
              );
            }),
          )
          .toBe(true);
        for (const name of ['跳到顶部', '上一条回答', '下一条回答', '跳到底部']) {
          const target = button(page, name),
            box = await target.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
          expect(box!.width).toBeLessThanOrEqual(56);
          expect(
            await target.evaluate((node) => {
              const b = node.getBoundingClientRect();
              return (
                document
                  .elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
                  ?.closest('button') === node
              );
            }),
          ).toBe(true);
        }
        // aria-disabled keeps native focus; force lets us test its no-op at a boundary too.
        // Actual hit targets were checked above, so this does not bypass occlusion checks.
        await button(page, '跳到顶部').tap({ force: true });
        await expect.poll(() => top(page)).toBe(0);
        await button(page, '跳到底部').tap({ force: true });
        await expect.poll(() => gap(page)).toBeLessThan(2);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`mobile-${size.width}-${size.font}.png`),
        });
      }
      await page.keyboard.press('ControlOrMeta+j');
      await expect(toolbar(page)).toHaveCount(0);
      await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    } finally {
      await context.setOffline(false);
      await fixture.cleanup();
    }
  });
});

test('search and version anchors yield to navigation, and deleted or hidden answers are excluded', async ({
  page,
}) => {
  const fixture = await setup(page);
  try {
    const edited = await page.request.patch(
      `/api/conversations/${fixture.id}/messages/${fixture.last}`,
      {
        headers,
        data: {
          requestId: crypto.randomUUID(),
          content:
            '另一版本的末尾回答\n\n' +
            Array.from({ length: 24 }, (_, i) => `新版本阅读段落 ${i}`).join('\n\n'),
        },
      },
    );
    expect(edited.ok()).toBe(true);
    const { messageId } = (await edited.json()) as { messageId: string };
    await page.keyboard.press('ControlOrMeta+f');
    await page.getByLabel('查找当前对话', { exact: true }).fill('尾部 TARGET');
    await expect(page.locator('[data-search-current]')).toHaveAttribute(
      'data-message-id',
      fixture.assistant,
    );
    await button(page, '跳到顶部').click();
    await expect.poll(() => top(page)).toBe(0);
    await expect(page.getByLabel('查找当前对话', { exact: true })).toHaveValue('尾部 TARGET');
    await page.getByRole('button', { name: '关闭对话搜索', exact: true }).click();
    await button(page, '跳到底部').click();
    await answer(page, fixture.last)
      .getByRole('button', { name: '下一个回答版本', exact: true })
      .click();
    await expect(page).toHaveURL(`/c/${fixture.id}?branch=${messageId}`);
    await button(page, '跳到顶部').click();
    await answer(page, fixture.user).evaluate((node) => {
      node.style.paddingBottom = '80px';
    });
    await expect.poll(() => top(page)).toBe(0);
    await button(page, '下一条回答').click();
    await button(page, '下一条回答').click();
    await expect(toolbar(page).getByRole('status')).toHaveText('已定位第 2 条回答，共 2 条');
    expect(
      (
        await page.request.delete(
          `/api/conversations/${fixture.id}/messages/${fixture.assistant}`,
          { headers },
        )
      ).ok(),
    ).toBe(true);
    await expect(answer(page, fixture.assistant)).toHaveAttribute('data-deleted', 'true');
    await button(page, '跳到顶部').click();
    await button(page, '下一条回答').click();
    await expect(toolbar(page).getByRole('status')).toHaveText('已定位第 1 条回答，共 1 条');
    await expect(button(page, '上一条回答')).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page, '下一条回答')).toHaveAttribute('aria-disabled', 'true');
    await expect(page).toHaveURL(`/c/${fixture.id}?branch=${messageId}`);
  } finally {
    await fixture.cleanup();
  }
});

test('a user-only path hides navigation until tall content needs boundary navigation', async ({
  page,
}) => {
  const fixture = await setup(page);
  try {
    await page.goto(`/c/${fixture.id}?branch=${fixture.user}`);
    await expect(answer(page, fixture.user)).toBeVisible();
    await expect(toolbar(page)).toHaveCount(0);
    // Simulate an attachment expanding after layout, without changing the answer graph.
    await answer(page, fixture.user).evaluate((node) => {
      node.style.minHeight = '1500px';
    });
    await expect(toolbar(page)).toBeVisible();
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(button(page, '上一条回答')).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page, '下一条回答')).toHaveAttribute('aria-disabled', 'true');
    await button(page, '跳到底部').press('Space');
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await button(page, '跳到顶部').click();
    await expect.poll(() => top(page)).toBe(0);
    await button(page, '跳到底部').click();
    await expect.poll(() => gap(page)).toBeLessThan(2);
  } finally {
    await fixture.cleanup();
  }
});

test('reading buttons pause a live answer and bottom navigation resumes continuous following', async ({
  page,
}) => {
  const fixture = await setup(page);
  const original = await page.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  try {
    const providerId = crypto.randomUUID();
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: 'Reading navigation fixture',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [{ id: 'scroll-test', name: '滚动测试', enabled: true }],
              },
            ],
            activeProviderId: providerId,
            activeModel: 'scroll-test',
            systemPrompt: '',
            maxOutputTokens: null,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).fill('生成中切换阅读位置');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const running = page.getByTestId('assistant-message').last();
    await expect(running).toHaveAttribute('data-status', 'running');
    const height = () => pane(page).evaluate((node) => node.scrollHeight);
    await button(page, '跳到顶部').click();
    const atStart = await height();
    await expect.poll(height).toBeGreaterThan(atStart + 100);
    await expect.poll(() => top(page)).toBe(0);
    await button(page, '下一条回答').click();
    const reading = await top(page),
      readingHeight = await height();
    await expect.poll(height).toBeGreaterThan(readingHeight + 100);
    expect(await top(page)).toBeCloseTo(reading, 0);
    await expect.poll(() => offset(page, fixture.assistant)).toBeCloseTo(12, 0);
    await expect(running).toHaveAttribute('data-status', 'running');
    await button(page, '跳到底部').click();
    const followingHeight = await height();
    await expect.poll(height).toBeGreaterThan(followingHeight + 100);
    await expect.poll(() => gap(page)).toBeLessThan(2);
  } finally {
    await fixture.cleanup();
    expect(
      (await page.request.put('/api/settings/providers', { headers, data: original })).ok(),
    ).toBe(true);
  }
});
