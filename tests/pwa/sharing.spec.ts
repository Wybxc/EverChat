import { expect, test } from '@playwright/test';
import type { SharedSnapshot } from '../../shared/sharing/types';
const headers = { Origin: 'http://127.0.0.1:5175' };
test('controlled public shares stay network-only, skip private startup and do not block PWA updates', async ({
  page,
  context,
  request,
}) => {
  await request.post('/__test/pwa/build', {
    headers,
    data: {
      version: 'a',
      failSettings: false,
      moduleResponse: 'normal',
      richMarkdown: false,
      publicSnapshot: null,
    },
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  const shared = await context.newPage(),
    privateCalls: string[] = [],
    publicCalls: string[] = [];
  shared.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api')) privateCalls.push(req.url());
    if (new URL(req.url()).pathname.startsWith('/public/')) publicCalls.push(req.url());
  });
  await shared.addInitScript(() => {
    navigator.serviceWorker.register = () => {
      throw new Error('Public pages must not register a service worker');
    };
    indexedDB.open = () => {
      throw new Error('Public pages must not open private databases');
    };
  });
  await shared.goto(`/s/${'a'.repeat(22)}`);
  await expect
    .poll(() => shared.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  const previousCalls = publicCalls.length;
  const response = await shared.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(shared.getByRole('heading', { name: '公开 PWA 快照', exact: true })).toBeVisible();
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  await expect(shared.getByText('全文末尾', { exact: true })).toBeVisible();
  await expect(
    shared
      .getByTestId('assistant-message')
      .first()
      .getByRole('heading', { name: 'Flash 分享模型', exact: true }),
  ).toBeVisible();
  await expect(
    shared
      .getByTestId('assistant-message')
      .last()
      .getByRole('heading', { name: 'EverChat', exact: true }),
  ).toBeVisible();
  await expect(shared.locator('article')).toHaveCount(4);
  expect(publicCalls.length - previousCalls).toBe(0);
  await expect(shared.getByRole('button', { name: '继续阅读' })).toHaveCount(0);
  const user = shared.getByTestId('user-message').first(),
    thought = shared.getByTestId('assistant-message').first().getByTestId('share-reasoning');
  await expect(user.locator('[data-share-user-text]')).toHaveText('公开提问\n第二行');
  await expect(thought).not.toHaveAttribute('open');
  await thought.locator('summary').click();
  await expect(thought.getByText('公开思考', { exact: true })).toBeVisible();
  await shared.setViewportSize({ width: 390, height: 740 });
  await shared.getByLabel('颜色模式').selectOption('dark');
  expect(await shared.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await shared.screenshot({
    path: `/tmp/everchat-sharing-full-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(privateCalls).toEqual([]);
  expect(
    await shared.evaluate(async () => {
      const paths = (
        await Promise.all(
          (await caches.keys()).map(async (name) =>
            (await (await caches.open(name)).keys()).map((req) => new URL(req.url).pathname),
          ),
        )
      ).flat();
      return paths.some(
        (path) => path.startsWith('/public/') || path.startsWith('/api/') || path.startsWith('/s/'),
      );
    }),
  ).toBe(false);
  await request.post('/__test/pwa/build', { headers, data: { version: 'b' } });
  if (!process.env.EVERCHAT_PWA_LEGACY_BUILD) {
    // A still-active SW must not save build B's HTML into its build A shell cache.
    const newerDocument = await shared.reload();
    expect(await newerDocument!.text()).toContain('name="everchat-build" content="pwa-test-b"');
    const cachedShells = await shared.evaluate(async () =>
      Promise.all(
        (await caches.keys())
          .filter((name) => name.endsWith('-share-pwa-test-a'))
          .map(async (name) => (await (await caches.open(name)).match('/share.html'))!.text()),
      ),
    );
    expect(cachedShells).toHaveLength(0);
    // Direct HTML navigation is also public and must not wait for a private update handshake.
    const direct = await context.newPage();
    await direct.goto('/share.html');
    await expect(direct.getByRole('alert')).toContainText('链接不可用');
  }
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新应用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更新应用', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await expect(page.getByTestId('app-version')).toHaveText('pwa-test-b');
  // Activation discards old hashed modules. Visit once online to cache the new public entry.
  const updatedDocument = await shared.reload();
  expect(await updatedDocument!.text()).toContain('name="everchat-build" content="pwa-test-b"');
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  expect(privateCalls).toEqual([]);
  expect(
    await shared.evaluate(async () =>
      (await caches.keys()).some((name) => name.endsWith('-share-pwa-test-a')),
    ),
  ).toBe(false);
  await context.setOffline(true);
  await shared.reload();
  await expect(shared.getByRole('alert')).toContainText('联网后重试');
  await expect(shared.getByText('公开正文', { exact: true })).not.toBeVisible();
  expect(privateCalls).toEqual([]);
  await context.setOffline(false);
  await request.post('/__test/pwa/build', { headers, data: { version: 'a' } });
});

test('shared pages use one document scrollbar and follow content height on desktop and phone', async ({
  page,
  request,
}) => {
  const snapshot: SharedSnapshot = {
    share: {
      id: 'a'.repeat(22),
      title: '滚动布局验证',
      createdAt: 1,
      expiresAt: null,
      messageCount: 2,
      omittedAttachments: 0,
      hash: 'fixture',
    },
    page: {
      cursor: null,
      blocks: [
        { message: 0, role: 'user', channel: 'text', text: '请检查长内容', omittedAttachments: 0 },
        {
          message: 1,
          role: 'assistant',
          channel: 'text',
          modelName: '布局模型',
          text: Array.from(
            { length: 60 },
            (_, i) => `段落 ${i + 1}。用于检查文档滚动和页面高度。`,
          ).join('\n\n'),
          omittedAttachments: 0,
        },
      ],
    },
  };
  await request.post('/__test/pwa/build', { headers, data: { publicSnapshot: snapshot } });
  await page.goto(`/s/${snapshot.share.id}`);
  await expect(
    page.getByText('段落 60。用于检查文档滚动和页面高度。', { exact: true }),
  ).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 740 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({
      viewport: innerHeight,
      documentHeight: document.scrollingElement!.scrollHeight,
      rootHeight: document.getElementById('root')!.getBoundingClientRect().height,
      nestedScrollers: [...document.querySelectorAll('#root *')].filter(
        (element) =>
          /auto|scroll/.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight + 1,
      ).length,
    }));
    expect(layout.documentHeight).toBeGreaterThan(layout.viewport * 2);
    expect(Math.abs(layout.documentHeight - layout.rootHeight)).toBeLessThanOrEqual(1);
    expect(layout.nestedScrollers).toBe(0);
    await page
      .getByText('段落 60。用于检查文档滚动和页面高度。', { exact: true })
      .scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(page.locator('header')).toBeInViewport();
  }
  snapshot.page.blocks[1].text = '简短回答';
  await request.post('/__test/pwa/build', { headers, data: { publicSnapshot: snapshot } });
  await page.reload();
  await expect(page.getByText('简短回答', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(740);
  await page.screenshot({
    path: `/tmp/everchat-sharing-layout-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('a visible shared snapshot disappears at expiry without extra network requests', async ({
  page,
  request,
}) => {
  await page.clock.install();
  const expiresAt = Date.now() + 60 * 86_400_000;
  const snapshot: SharedSnapshot = {
    share: {
      id: 'a'.repeat(22),
      title: '到期清除',
      createdAt: Date.now(),
      expiresAt,
      messageCount: 1,
      omittedAttachments: 0,
      hash: 'fixture',
    },
    page: {
      cursor: null,
      blocks: [
        { message: 0, role: 'assistant', channel: 'text', text: '限时内容', omittedAttachments: 0 },
      ],
    },
  };
  let reads = 0;
  await request.post('/__test/pwa/build', { headers, data: { publicSnapshot: snapshot } });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/public/')) reads++;
  });
  await page.goto(`/s/${snapshot.share.id}`);
  await expect(page.getByText('限时内容', { exact: true })).toBeVisible();
  const initialReads = reads;
  // Long expirations must not overflow the browser's 32-bit timeout delay.
  await page.clock.fastForward(2_147_483_647);
  await expect(page.getByText('限时内容', { exact: true })).toBeVisible();
  await page.clock.fastForward(2_147_483_647);
  await expect(page.getByText('限时内容', { exact: true })).toBeVisible();
  await page.clock.fastForward(60 * 86_400_000 - 2 * 2_147_483_647 + 1000);
  await expect(page.getByRole('alert')).toContainText('链接不可用');
  await expect(page.locator('article')).toHaveCount(0);
  expect(reads).toBe(initialReads);
});
