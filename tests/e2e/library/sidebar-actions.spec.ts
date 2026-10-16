import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { messageMenu } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
async function seed(request: APIRequestContext) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const ids: string[] = [];
  for (const title of ['阅读中的 A', '后台操作 B', '另一对话 C']) {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      (await request.post('/api/conversations', { headers, data: { id, title } })).status(),
    ).toBe(201);
    expect(
      (
        await request.post(`/api/__test/conversations/${id}/search-history`, {
          headers,
          data: {},
        })
      ).ok(),
    ).toBe(true);
  }
  return {
    ids,
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
    },
  };
}
const row = (page: Page, id: string) => page.locator(`[data-conversation-row="${id}"]`);
async function menu(page: Page, id: string) {
  const button = row(page, id).getByRole('button');
  await button.focus();
  await button.press('Space');
}
async function rememberOldBranch(page: Page, id: string) {
  await page.goto(`/c/${id}`);
  const snapshot = (await page.request
    .get(`/api/conversations/${id}`)
    .then((r) => r.json())) as Snapshot;
  await messageMenu(page.getByTestId('assistant-message').first());
  await page.getByRole('menuitem', { name: '从这里继续', exact: true }).click();
  const head = snapshot.messages.find((message) => message.role === 'assistant')!.id;
  await expect(page).toHaveURL((url) => url.searchParams.get('branch') === head);
  return head;
}

test('sidebar commands target B while A keeps its URL, branch and draft, including errors, offline links and deletion', async ({
  page,
  context,
}) => {
  const source = await seed(page.request),
    [a, b] = source.ids;
  try {
    const head = await rememberOldBranch(page, b);
    await row(page, a).getByRole('link').click();
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('A 中未发送的草稿');
    const url = page.url();
    await menu(page, b);
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
    const input = dialog.getByLabel('对话名称', { exact: true });
    await expect(input).toBeFocused();
    await input.fill('  ');
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await input.fill('已修改的 B');
    await page.route(
      `**/api/conversations/${b}`,
      async (route) => {
        if (route.request().method() === 'PATCH')
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"保存失败，请重试。"}',
          });
        else await route.continue();
      },
      { times: 1 },
    );
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('保存失败');
    await expect(input).toHaveValue('已修改的 B');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(row(page, b).getByRole('link')).toHaveText('已修改的 B');
    await expect(row(page, b).getByRole('button')).toBeFocused();
    await expect(page).toHaveURL(url);
    await expect(composer).toHaveValue('A 中未发送的草稿');
    await menu(page, b);
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await menu(page, b);
    await expect(page.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.setOffline(true);
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeDisabled();
    await page.getByRole('menuitem', { name: '复制链接', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '链接已复制', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${origin}/c/${b}?branch=${head}`,
    );
    await page.keyboard.press('Escape');
    await context.setOffline(false);
    await menu(page, b);
    await page.getByRole('menuitem', { name: '归档', exact: true }).click();
    await expect(row(page, b)).toHaveCount(0);
    await expect(page.locator('body')).not.toBeFocused();
    await expect(page).toHaveURL(url);
    await page.getByRole('tab', { name: '归档', exact: true }).click();
    await menu(page, b);
    await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await menu(page, b);
    await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: '删除对话', exact: true });
    await expect(confirmation).toContainText('已修改的 B');
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '删除', exact: true }).click();
    await expect(row(page, b)).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await expect(composer).toHaveValue('A 中未发送的草稿');
    expect((await page.request.get(`/api/conversations/${a}`)).status()).toBe(200);
    expect((await page.request.get(`/api/conversations/${b}`)).status()).toBe(410);
  } finally {
    await context.setOffline(false);
    await source.cleanup();
  }
});

test('copying a sidebar conversation uses its own cached branch and does not override navigation during a slow reply', async ({
  page,
}) => {
  const source = await seed(page.request),
    [a, b, c] = source.ids;
  let release = () => {};
  try {
    const head = await rememberOldBranch(page, b);
    await row(page, a).getByRole('link').click();
    await page.getByLabel('消息', { exact: true }).fill('A 草稿');
    let copied: string | undefined,
      copyHead: string | undefined,
      posted: { viewHeadId?: string } | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      `**/api/conversations/${b}/duplicate`,
      async (route) => {
        posted = route.request().postDataJSON();
        const response = await route.fetch();
        const result = await response.json();
        copied = result.id;
        copyHead = result.viewHeadId;
        source.ids.push(copied!);
        await gate;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await menu(page, b);
    await page.getByRole('menuitem', { name: '复制对话', exact: true }).click();
    await menu(page, b);
    await expect(page.getByRole('menuitem', { name: '复制对话', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect.poll(() => copied).toBeTruthy();
    expect(posted?.viewHeadId).toBe(head);
    await row(page, c).getByRole('link').click();
    await page.getByLabel('消息', { exact: true }).fill('C 草稿');
    const current = page.url();
    release();
    await expect.poll(() => row(page, copied!).count()).toBe(1);
    await expect(page).toHaveURL(current);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('C 草稿');
    const copy = (await page.request
      .get(`/api/conversations/${copied}`)
      .then((r) => r.json())) as Snapshot;
    expect(copy.messages).toHaveLength(3);
    expect(copyHead).toBe(copy.messages[1].id);
    await menu(page, b);
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/conversations/${b}/duplicate`) && r.status() === 201,
    );
    await page.getByRole('menuitem', { name: '复制对话', exact: true }).click();
    const next = (await (await response).json()).id as string;
    source.ids.push(next);
    await expect(page).toHaveURL((url) => url.pathname === `/c/${next}`);
    await row(page, a).getByRole('link').click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('A 草稿');
  } finally {
    release();
    await source.cleanup();
  }
});

test('mobile row dialogs replace the sidebar focus trap and restore its trigger without changing A', async ({
  page,
}) => {
  const source = await seed(page.request),
    [a, b] = source.ids;
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/c/${a}`);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('手机草稿');
    const current = page.url(),
      sidebar = page.getByRole('button', { name: '打开对话列表', exact: true });
    await sidebar.click();
    const trigger = row(page, b).getByRole('button');
    const box = await trigger.boundingBox();
    // Animated browser geometry may round 44 CSS px a few millionths down.
    expect(box!.width).toBeGreaterThanOrEqual(43.99);
    expect(box!.height).toBeGreaterThanOrEqual(43.99);
    await menu(page, b);
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
    await expect(dialog.getByLabel('对话名称')).toBeFocused();
    await expect(page.locator('[data-slot="sheet-content"][data-state="open"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(sidebar).toBeFocused();
    await expect(page).toHaveURL(current);
    await expect(composer).toHaveValue('手机草稿');
    await sidebar.click();
    await menu(page, b);
    await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(sidebar).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await source.cleanup();
  }
});
