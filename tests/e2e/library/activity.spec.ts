import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import type { LibrarySnapshot, Submission } from '../../../shared/conversation/types';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };
const slow = 'benchmark-text-1000-50-32',
  quick = 'benchmark-text-40-50-32';
const control = (request: APIRequestContext, id: string, data: unknown = {}) =>
  request
    .post('/api/__test/library/activity', { headers, data: { id, ...(data as object) } })
    .then((r) => r.json()) as Promise<{ calls: number; activity: ConversationActivity | null }>;
const state = (request: APIRequestContext, id: string, expire = false) =>
  request
    .post(`/api/__test/conversations/${id}/activity`, { headers, data: { expire } })
    .then((r) => r.json()) as Promise<{
    row: { payload: string; pending: number; attempts: number };
    calls: number;
    alarmAt: number | null;
  }>;
const snapshot = (request: APIRequestContext, id: string) =>
  request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
const index = (request: APIRequestContext) =>
  request.get('/api/conversations').then((r) => r.json()) as Promise<LibrarySnapshot>;
const row = (page: Page, id: string) => page.locator(`[data-conversation-row="${id}"]`);
async function menu(page: Page, id: string) {
  const trigger = row(page, id).getByRole('button');
  await trigger.focus();
  await trigger.press('Space');
}
async function setup(request: APIRequestContext) {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    ids: string[] = [];
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          ...original,
          activeProviderId: providerId,
          activeModel: slow,
          providers: [
            {
              id: providerId,
              name: 'Activity fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [slow, quick].map((id) => ({ id, name: id, enabled: true })),
            },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  return {
    ids,
    create: async (title: string) => {
      const id = crypto.randomUUID();
      ids.push(id);
      expect(
        (await request.post('/api/conversations', { headers, data: { id, title } })).status(),
      ).toBe(201);
      return id;
    },
    submit: async (id: string, model = slow) => {
      const prior = (await snapshot(request, id)).messages.find(
        (message) => message.role === 'assistant',
      );
      const response = await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: {
          requestId: crypto.randomUUID(),
          ...(prior ? { retryOf: prior.id } : { parentId: null, content: '活动索引测试' }),
          selection: { providerId, model },
        },
      });
      expect(response.status()).toBe(202);
      return (await response.json()) as Submission;
    },
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('lifecycle reports are finite during raw streaming, survive Library restart and cannot revive a deleted conversation', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = await fixture.create('索引生命周期');
  try {
    const accepted = await fixture.submit(id);
    expect(accepted.activity).toMatchObject({
      status: 'queued',
      version: 1,
      messageId: accepted.assistantId,
      runId: accepted.runId,
    });
    await expect.poll(async () => (await control(request, id)).activity?.status).toBe('running');
    const running = (await control(request, id)).activity!;
    const before = await control(request, id);
    const concurrent = await fixture.create('同时生成的另一对话');
    await fixture.submit(concurrent);
    await expect
      .poll(async () => (await control(request, concurrent)).activity?.status)
      .toBe('running');
    await expect
      .poll(async () => (await snapshot(request, id)).messages[1].durableOffset ?? 0)
      .toBeGreaterThan(8000);
    expect((await control(request, id)).calls).toBe(before.calls);
    expect(before.calls).toBeLessThanOrEqual(2);
    await request.post('/api/__test/library/web-tools/reset', { headers });
    expect((await index(request)).activity[id]).toEqual(running);
    const stopped = await request
      .post(`/api/conversations/${id}/cancel`, { headers, data: { runId: accepted.runId } })
      .then((r) => r.json());
    expect(stopped.activity.status).toBe('idle');
    expect((await control(request, concurrent)).activity?.status).toBe('running');
    await expect.poll(async () => (await control(request, id)).activity?.status).toBe('idle');
    const idle = (await control(request, id)).activity!;
    expect(idle.version).toBeGreaterThan(running.version);
    await control(request, id, { report: running });
    expect((await control(request, id)).activity).toEqual(idle);
    expect((await state(request, id)).calls).toBe(1);
    await request.delete(`/api/conversations/${id}`, { headers });
    await control(request, id, { report: { ...running, version: idle.version + 10 } });
    expect((await index(request)).activity[id]).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test('failed lifecycle delivery recovers after Conversation restart without reissuing a paid model call', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = await fixture.create('索引上报失败');
  try {
    await control(request, id, { fail: true });
    const accepted = await fixture.submit(id);
    await expect.poll(async () => (await state(request, id)).calls).toBe(1);
    await expect.poll(async () => (await state(request, id)).row.attempts).toBeGreaterThan(0);
    expect((await state(request, id)).row.pending).toBe(1);
    expect((await control(request, id)).activity).toBeNull();
    await request.post(`/api/__test/conversations/${id}/abort`, {
      headers,
      data: { runId: accepted.runId },
    });
    const recovered = await snapshot(request, id);
    expect(recovered.messages[1].status).toBe('failed');
    expect(recovered.activity?.status).toBe('idle');
    await control(request, id, { fail: false });
    await state(request, id, true);
    await expect.poll(async () => (await control(request, id)).activity?.status).toBe('idle');
    expect(await state(request, id)).toMatchObject({
      calls: 1,
      row: { pending: 0 },
      alarmAt: null,
    });
    await request.post('/api/__test/library/web-tools/reset', { headers });
    expect((await index(request)).activity[id]?.status).toBe('idle');
  } finally {
    await fixture.cleanup();
  }
});

test('sidebar tasks target B while A keeps its draft, and a stale stop cannot cancel a newer run', async ({
  page,
}) => {
  const fixture = await setup(page.request),
    a = await fixture.create('阅读 A'),
    b = await fixture.create('生成 B');
  try {
    await page.goto(`/c/${a}`);
    const editor = page.getByLabel('消息', { exact: true });
    await editor.fill('A 的草稿');
    const first = await fixture.submit(b);
    await expect(row(page, b).getByRole('status', { name: '生成中', exact: true })).toBeVisible();
    const url = page.url();
    await menu(page, b);
    // Keep this menu open across B's next lifecycle. It must retain the old run ID.
    await page.request.post(`/api/conversations/${b}/cancel`, {
      headers,
      data: { runId: first.runId },
    });
    const second = await fixture.submit(b);
    await expect
      .poll(async () => (await snapshot(page.request, b)).messages.at(-1)?.status)
      .toBe('running');
    await page.getByRole('menuitem', { name: '停止生成', exact: true }).click();
    expect((await snapshot(page.request, b)).messages.at(-1)?.status).toBe('running');
    await expect(page).toHaveURL(url);
    await expect(editor).toHaveValue('A 的草稿');
    await menu(page, b);
    await page.getByRole('menuitem', { name: '停止生成', exact: true }).click();
    await expect(row(page, b).getByRole('status')).toHaveCount(0);
    expect((await snapshot(page.request, b)).messages.at(-1)?.status).toBe('cancelled');
    expect((await snapshot(page.request, b)).messages.at(-1)?.runId).toBe(second.runId);
    await expect(editor).toHaveValue('A 的草稿');
    await expect(page).toHaveURL(url);
  } finally {
    await fixture.cleanup();
  }
});

test('activity is visible on another branch and device, goes static offline, and explicit task navigation selects its branch', async ({
  page,
  context,
  browser,
}) => {
  const fixture = await setup(page.request),
    id = await fixture.create('多分支生成');
  const other = await browser.newContext({ locale: 'zh-CN' });
  try {
    const old = await fixture.submit(id, quick);
    await expect
      .poll(async () => (await snapshot(page.request, id)).messages[1].status)
      .toBe('completed');
    await page.goto(`/c/${id}?branch=${old.assistantId}`);
    const next = await fixture.submit(id);
    await expect(row(page, id).getByRole('status', { name: '生成中', exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('branch') === old.assistantId);
    await other.request.post('/__dev/access/login', { headers });
    const second = await other.newPage();
    await second.goto('/');
    await expect(
      row(second, id).getByRole('status', { name: '生成中', exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    const stale = row(page, id).getByRole('status', { name: '生成状态待同步', exact: true });
    await expect(stale).toBeVisible();
    await expect(stale.locator('[data-slot="spinner"]')).toHaveCount(0);
    await menu(page, id);
    await expect(page.getByRole('menuitem', { name: '停止生成', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await context.setOffline(false);
    await menu(page, id);
    await page.getByRole('menuitem', { name: '查看生成位置', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('branch') === next.assistantId);
    await expect(page.locator(`[data-message-id="${next.assistantId}"]`)).toBeVisible();
    await page.request.post(`/api/conversations/${id}/cancel`, {
      headers,
      data: { runId: next.runId },
    });
    await expect(row(page, id).getByRole('status')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await other.close();
    await fixture.cleanup();
  }
});

test('mobile task menus keep status and touch targets visible at 320px and 200% text', async ({
  page,
}) => {
  const fixture = await setup(page.request),
    id = await fixture.create('窄屏长标题生成任务的完整名称');
  try {
    await fixture.submit(id);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await page.getByRole('button', { name: '打开对话列表', exact: true }).click();
    const status = row(page, id).getByRole('status', { name: '生成中', exact: true });
    await expect(status).toBeVisible();
    const trigger = row(page, id).getByRole('button');
    await trigger.scrollIntoViewIfNeeded();
    const statusBox = await status.boundingBox(),
      sheetBox = await page.locator('[data-slot="sheet-content"]').boundingBox();
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(sheetBox!.x + sheetBox!.width);
    const box = await trigger.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(
      await status
        .locator('[data-slot="spinner"]')
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    await page.screenshot({ path: '/tmp/everchat-activity-mobile.png' });
    await menu(page, id);
    await page.getByRole('menuitem', { name: '停止生成', exact: true }).click();
    await expect(row(page, id).getByRole('status')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await fixture.cleanup();
  }
});
