import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

test.beforeEach(async ({ request }) => {
  await control(request, { version: 'a', failSettings: false, failAsset: false, failSw: false });
});

test('two real production builds wait for unsaved settings in every tab and preserve both drafts when updated', async ({
  page,
  context,
}) => {
  await controlled(page, `/c/${id}`);
  const second = await context.newPage();
  await controlled(second);
  await page.getByLabel('消息', { exact: true }).fill('第一页的未发送草稿');
  await second.getByLabel('消息', { exact: true }).fill('第二页的新对话草稿');
  await control(page.request, { failSettings: true });
  const otherSettings = await settings(second);
  await otherSettings.getByRole('tab', { name: '对话', exact: true }).click();
  await otherSettings.getByLabel('系统提示词', { exact: true }).fill('尚未保存的配置');
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
  await expect(otherSettings.getByLabel('系统提示词', { exact: true })).toHaveValue(
    '尚未保存的配置',
  );
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
            archived: false,
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
  await expect(page.getByTestId('pwa-notice')).toContainText('注册失败');
  await control(page.request, { failSw: false });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await expect(panel).toContainText('离线资源已就绪');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('注册失败时的草稿');
});

test('an interrupted update keeps the old version and draft, then retries safely', async ({
  page,
}) => {
  await controlled(page);
  await page.getByLabel('消息', { exact: true }).fill('更新中断时的草稿');
  const panel = await settings(page);
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
