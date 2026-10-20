import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../shared/conversation/settings';

const id = '00000000-0000-4000-8000-000000000101';
const control = (request: APIRequestContext, data: unknown) =>
  request.post('/__test/pwa/build', { headers: { Origin: 'http://127.0.0.1:5175' }, data });
async function settings(page: Page) {
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  return page.getByRole('dialog', { name: '设置', exact: true });
}
async function controlled(page: Page, path = '/') {
  await page.goto(path);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
}
async function version(page: Page) {
  const result = await page.evaluate(async () => {
    const channel = new MessageChannel();
    const value = new Promise<string>(
      (resolve) => (channel.port1.onmessage = (event) => resolve(event.data.version)),
    );
    navigator.serviceWorker.controller!.postMessage({ channel: 'everchat:pwa', type: 'version' }, [
      channel.port2,
    ]);
    return value;
  });
  return result;
}
async function cacheOptionalModule(page: Page) {
  const { optionalAsset } = (await (await control(page.request, {})).json()) as {
    optionalAsset: string;
  };
  await page.evaluate((url) => fetch(url).then(() => undefined), optionalAsset);
  await expect
    .poll(() => page.evaluate(async (url) => Boolean(await caches.match(url)), optionalAsset))
    .toBe(true);
  return optionalAsset;
}

test.beforeEach(async ({ request }) => {
  await control(request, {
    version: 'a',
    resetSettings: true,
    failSettings: false,
    failAsset: false,
    failSw: false,
    swMode: 'normal',
    swDelay: 0,
    assetDelay: 0,
  });
});
test.afterEach(async ({ context, request }) => {
  await context.setOffline(false);
  await control(request, {
    version: 'a',
    failSettings: false,
    failAsset: false,
    failSw: false,
    swMode: 'normal',
    swDelay: 0,
    assetDelay: 0,
  });
});

test('a production update preserves cached new-chat parameters without an update loop', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    (settings) => {
      if (!localStorage.getItem('everchat:conversation-settings:new'))
        localStorage.setItem('everchat:conversation-settings:new', JSON.stringify(settings));
    },
    { ...DEFAULT_CONVERSATION_SETTINGS, systemPrompt: '升级前的本机提示词', useSummaries: false },
  );
  await controlled(page);
  await page.getByLabel('消息', { exact: true }).fill('升级后保留草稿');
  const panel = await settings(page);
  await control(page.request, { version: 'b' });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByTestId('pwa-notice')).toContainText('新版本已就绪');
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    panel.getByRole('button', { name: '更新应用', exact: true }).click(),
  ]);
  await expect.poll(() => version(page)).toBe('pwa-test-b');
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('升级后保留草稿');
  expect(errors).toEqual([]);
});

test('two real production builds wait for unsaved settings in every tab and preserve both drafts when updated', async ({
  page,
  context,
}) => {
  await controlled(page, `/c/${id}`);
  const second = await context.newPage();
  await controlled(second);
  const optionalAsset = await cacheOptionalModule(page);
  await page.getByLabel('消息', { exact: true }).fill('第一页的未发送草稿');
  await second.getByLabel('消息', { exact: true }).fill('第二页的新对话草稿');
  await control(page.request, { failSettings: true });
  const otherSettings = await settings(second);
  await otherSettings.getByRole('tab', { name: '供应商', exact: true }).click();
  await otherSettings.getByRole('button', { name: '添加供应商', exact: true }).click();
  await otherSettings.getByLabel('名称', { exact: true }).fill('尚未保存的供应商');
  await expect(otherSettings.getByTestId('settings-save-status')).toContainText('未保存');
  await control(page.request, { version: 'b' });
  const firstSettings = await settings(page);
  await firstSettings.getByRole('button', { name: '检查更新', exact: true }).click();
  const notice = page.getByTestId('pwa-notice');
  await expect(notice).toContainText('新版本已就绪');
  // The waiting worker does not activate or reload either page by itself.
  expect(await version(page)).toBe('pwa-test-a');
  await firstSettings.getByRole('button', { name: '更新应用', exact: true }).click();
  await expect(firstSettings.getByRole('alert')).toContainText('设置尚未保存');
  expect(await version(page)).toBe('pwa-test-a');
  await expect(otherSettings.getByLabel('名称', { exact: true })).toHaveValue('尚未保存的供应商');
  await control(page.request, { failSettings: false });
  await otherSettings.getByRole('button', { name: '重试', exact: true }).click();
  await expect(otherSettings.getByTestId('settings-save-status')).toContainText('已保存');
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    second.waitForEvent('framenavigated', (frame) => frame === second.mainFrame()),
    firstSettings.getByRole('button', { name: '更新应用', exact: true }).click(),
  ]);
  await expect.poll(() => version(page)).toBe('pwa-test-b');
  await expect.poll(() => version(second)).toBe('pwa-test-b');
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('第一页的未发送草稿');
  await expect(second.getByLabel('消息', { exact: true })).toHaveValue('第二页的新对话草稿');
  await settings(page);
  await expect(page.getByTestId('app-version')).toHaveText('pwa-test-b');
  expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), optionalAsset)).toBe(
    true,
  );
});

test('repair only removes app static caches and keeps chat IndexedDB, drafts and offline requests', async ({
  page,
}) => {
  await controlled(page, `/c/${id}`);
  await page.getByLabel('消息', { exact: true }).fill('修复后仍保留的草稿');
  await page.evaluate(async () => {
    await (await caches.open('another-app-cache')).put('/unrelated', new Response('keep'));
    localStorage.setItem(
      'everchat:pending',
      JSON.stringify([
        {
          owner: 'offline-owner',
          conversation: {
            id: '00000000-0000-4000-8000-000000000102',
            title: '离线待发送',
            createdAt: 1,
            updatedAt: 1,
            pinned: false,
          },
          input: { requestId: '00000000-0000-4000-8000-000000000103', content: '断网期间的消息' },
          error: '等待身份确认',
        },
      ]),
    );
  });
  const panel = await settings(page);
  await panel.getByRole('button', { name: '修复应用缓存', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '修复应用缓存', exact: true });
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    confirmation.getByRole('button', { name: '修复并重新加载', exact: true }).click(),
  ]);
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('修复后仍保留的草稿');
  await expect(page.getByTestId('assistant-message')).toContainText('已保存的正文');
  expect(await page.evaluate(async () => (await caches.match('/unrelated'))?.text())).toBe('keep');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!)[0].input),
  ).toEqual({ requestId: '00000000-0000-4000-8000-000000000103', content: '断网期间的消息' });
  expect(
    await page.evaluate(() =>
      Boolean(
        localStorage.getItem(
          `everchat:snapshot:parts-v1:${'00000000-0000-4000-8000-000000000101'}`,
        ),
      ),
    ),
  ).toBe(true);
});

test('failed registration is visible and can be retried without losing a draft', async ({
  page,
}) => {
  await control(page.request, { failSw: true });
  await page.goto('/');
  await page.getByLabel('消息', { exact: true }).fill('注册失败时的草稿');
  const panel = await settings(page);
  await expect(panel.getByRole('alert')).toContainText('暂时无法检查更新');
  await expect(page.getByTestId('pwa-notice')).toHaveCount(0);
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('更新服务暂不可用');
  await control(page.request, { failSw: false });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await expect(panel).toContainText('可离线启动');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('注册失败时的草稿');
});

test('a failed first resource install reacquires registration on retry and preserves the draft', async ({
  page,
}) => {
  // The shell remains usable when a required offline icon fails to install.
  await control(page.request, { failAsset: true });
  await page.goto('/');
  await page.getByLabel('消息', { exact: true }).fill('首次离线安装失败的草稿');
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    )
    .toBe(0);
  await control(page.request, { failAsset: false });
  const panel = await settings(page);
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await expect(panel).toContainText('可离线启动');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('首次离线安装失败的草稿');
});

test('an interrupted update keeps the old version and draft, then retries safely', async ({
  page,
}) => {
  await controlled(page);
  await page.getByLabel('消息', { exact: true }).fill('更新中断时的草稿');
  const panel = await settings(page);
  // Force an unchanged required resource to be reacquired by the new installation.
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith('everchat-static-')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        if (new URL(request.url).pathname === '/icon-512.png') await cache.delete(request);
    }
  });
  await control(page.request, { version: 'b', failAsset: true });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('离线资源未能准备');
  expect(await version(page)).toBe('pwa-test-a');
  await control(page.request, { failAsset: false });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('button', { name: '更新应用', exact: true })).toBeVisible();
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    panel.getByRole('button', { name: '更新应用', exact: true }).click(),
  ]);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('更新中断时的草稿');
  expect(await version(page)).toBe('pwa-test-b');
});

test('offline and malformed update scripts have distinct feedback without losing the active app', async ({
  page,
  context,
}) => {
  await controlled(page);
  const panel = await settings(page);
  await context.setOffline(true);
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('当前离线');
  await context.setOffline(false);
  await control(page.request, { swMode: 'html' });
  await expect(panel.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('更新文件异常');
  await panel.getByText('更新诊断', { exact: true }).click();
  await expect(panel.locator('pre')).toContainText('"failure": "script"');
  expect(await version(page)).toBe('pwa-test-a');
  await control(page.request, { swMode: 'normal' });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('slow checks end their UI wait, coalesce retries and cannot overwrite a late successful result', async ({
  page,
}) => {
  await controlled(page);
  const panel = await settings(page);
  await control(page.request, { swDelay: 18000 });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('浏览器仍在处理', { timeout: 17000 });
  await expect(panel.getByRole('button', { name: '浏览器仍在检查', exact: true })).toBeDisabled();
  await expect(panel.getByRole('alert')).toHaveCount(0, { timeout: 10000 });
  await expect(panel.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
  expect(await version(page)).toBe('pwa-test-a');
});

test('retrying a first installation downloads resources without queueing another update or a check timeout', async ({
  page,
}) => {
  await control(page.request, { failSw: true });
  await page.goto('/');
  await page.getByLabel('消息', { exact: true }).fill('慢速安装时保留的草稿');
  const panel = await settings(page);
  await expect(panel.getByRole('alert')).toContainText('暂时无法检查更新');
  const before = await control(page.request, { failSw: false, assetDelay: 20000 });
  const { swRequests } = (await before.json()) as { swRequests: number };
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('button', { name: '准备更新资源', exact: true })).toBeDisabled();
  await panel.getByText('更新诊断', { exact: true }).click();
  await expect(panel.locator('pre')).toContainText('"phase": "install"');
  // The browser install job stays live beyond the check deadline. Background signals reuse it.
  await page.evaluate(() => window.dispatchEvent(new Event('everchat:network-ready')));
  await expect(panel.locator('pre')).toContainText('"phase": "install"');
  await page.waitForTimeout(16000);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('pre')).not.toContainText('"failure": "timeout"');
  await expect(panel).toContainText('可离线启动');
  const after = await control(page.request, {});
  expect(((await after.json()) as { swRequests: number }).swRequests).toBe(swRequests + 1);
  await expect(panel.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('慢速安装时保留的草稿');
});

test('mobile production search leaves a tappable close control and returns focus to the sidebar trigger', async ({
  browser,
}) => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await controlled(page);
    const trigger = page.getByRole('button', { name: '打开对话列表' });
    await trigger.tap();
    await page.getByRole('button', { name: '全局搜索', exact: true }).tap();
    const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
    const input = search.getByRole('combobox');
    await expect(input).toHaveCSS('font-size', '16px');
    await expect(input).toBeFocused();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(input).toHaveCSS('font-size', '16px');
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(input).toHaveCSS('font-size', '16px');
    await search.getByRole('button', { name: '关闭全局搜索' }).tap();
    await expect(search).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});

test('a failed repair download retains the active cache and unrelated caches until a coordinated retry succeeds', async ({
  page,
}) => {
  await controlled(page);
  const optionalAsset = await cacheOptionalModule(page);
  await page.getByLabel('消息', { exact: true }).fill('修复下载失败仍保留的草稿');
  await page.evaluate(async () => {
    await (await caches.open('another-app-cache')).put('/unrelated', new Response('keep'));
  });
  const oldCaches = await page.evaluate(async () =>
    (await caches.keys()).filter((name) => name.startsWith('everchat-static-')),
  );
  const panel = await settings(page);
  const repair = async () => {
    await panel.getByRole('button', { name: '修复应用缓存', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '修复应用缓存', exact: true })
      .getByRole('button', { name: '修复并重新加载', exact: true })
      .click();
  };
  await control(page.request, { failAsset: true });
  await repair();
  await expect(panel.getByRole('alert')).toContainText('当前版本继续可用');
  expect(await version(page)).toBe('pwa-test-a');
  expect(await page.evaluate(async () => (await caches.match('/unrelated'))?.text())).toBe('keep');
  const retained = await page.evaluate(() => caches.keys());
  for (const name of oldCaches) expect(retained).toContain(name);
  expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), optionalAsset)).toBe(
    true,
  );
  await control(page.request, { failAsset: false });
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    repair(),
  ]);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('修复下载失败仍保留的草稿');
  expect(await page.evaluate(async () => (await caches.match('/unrelated'))?.text())).toBe('keep');
  await expect
    .poll(() => page.evaluate(async (url) => Boolean(await caches.match(url)), optionalAsset))
    .toBe(false);
});

test('retired archive flags in an existing offline cache do not hide titles from the sidebar or search', async ({
  page,
  context,
}) => {
  await controlled(page);
  const legacy = [
    {
      id: '00000000-0000-4000-8000-000000000105',
      title: '原归档的本地对话',
      createdAt: 1,
      updatedAt: 2,
      pinned: true,
      archived: true,
    },
  ];
  await page.evaluate(async (value) => {
    localStorage.setItem('everchat:library', JSON.stringify(value));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put(value, 'everchat:library');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, legacy);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(
      page.locator('aside').getByRole('link', { name: '原归档的本地对话', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
    await search.getByRole('combobox').fill('原归档');
    await expect(search.getByRole('link', { name: '原归档的本地对话', exact: true })).toBeVisible();
    await expect(search.getByRole('tab')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});

test('repair supersedes an already waiting update and activates its fresh cache generation', async ({
  page,
}) => {
  await controlled(page);
  const panel = await settings(page);
  await control(page.request, { version: 'b' });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(panel.getByRole('button', { name: '更新应用', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '修复应用缓存', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '修复应用缓存', exact: true });
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    confirm.getByRole('button', { name: '修复并重新加载', exact: true }).click(),
  ]);
  await expect.poll(() => version(page)).toBe('pwa-test-b');
  expect(
    await page.evaluate(() =>
      new URL(navigator.serviceWorker.controller!.scriptURL).searchParams.has('repair'),
    ),
  ).toBe(true);
});
