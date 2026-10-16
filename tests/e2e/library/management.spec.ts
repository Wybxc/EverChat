import { expect, test, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import type { LibrarySnapshot } from '../../../shared/conversation/types';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot, SyncPacket } from '../../../shared/streaming/protocol';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
const action = (request: APIRequestContext, id: string, name: string, data: unknown = {}) =>
  request.post(`/api/__test/conversations/${id}/${name}`, { headers, data });
const index = (request: APIRequestContext) =>
  request.get('/api/conversations').then((response) => response.json()) as Promise<LibrarySnapshot>;
const deletion = (request: APIRequestContext, id: string) =>
  request
    .post('/api/__test/library/deletion', { headers, data: { id } })
    .then((response) => response.json()) as Promise<{ deletedAt: number; calls: number }>;
async function setup(request: APIRequestContext, model = 'benchmark-text-2-10-32') {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Management fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: model, name: 'Management fixture', enabled: true }],
            },
          ],
          activeProviderId: providerId,
          activeModel: model,
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  const id = crypto.randomUUID(),
    title = `Management ${id.slice(0, 8)}`;
  const response = await request.post('/api/conversations', { headers, data: { id, title } });
  expect(response.status()).toBe(201);
  return {
    id,
    title,
    created: await response.json(),
    restore: async () => {
      expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
        true,
      );
    },
  };
}
async function subscribe(request: APIRequestContext, id: string) {
  const { cookies } = await request.storageState();
  const socket = new WebSocket(
    `${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`,
    {
      headers: {
        ...headers,
        Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      },
    },
  );
  const packets: SyncPacket[] = [];
  let closeCode: number | undefined;
  socket.on('close', (code) => {
    closeCode = code;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscriber readiness timeout')), 10_000);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('message', (data) => {
      const packet = JSON.parse(data.toString()) as SyncPacket;
      packets.push(packet);
      if (packet.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (packet.type === 'preview')
        socket.send(
          JSON.stringify({
            type: 'preview-ack',
            runId: packet.batch.runId,
            messageId: packet.batch.messageId,
            offset: packet.batch.endOffset,
          }),
        );
    });
  });
  return { socket, packets, closeCode: () => closeCode };
}

test('management API validates changes, requires authentication and same origin, and orders pinned conversations first', async ({
  request,
}) => {
  const id = crypto.randomUUID();
  expect(
    (await request.patch(`/api/conversations/${id}`, { headers, data: { pinned: true } })).status(),
  ).toBe(401);
  expect((await request.delete(`/api/conversations/${id}`, { headers })).status()).toBe(401);
  const fixture = await setup(request);
  try {
    expect(
      (
        await request.patch(`/api/conversations/${fixture.id}`, {
          headers: { Origin: 'https://untrusted.invalid' },
          data: { title: '不允许' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}`, {
          headers: { Origin: 'https://untrusted.invalid' },
        })
      ).status(),
    ).toBe(403);
    for (const data of [{ title: ' ' }, { title: 'x'.repeat(81) }, { pinned: 'yes' }, {}]) {
      expect(
        (await request.patch(`/api/conversations/${fixture.id}`, { headers, data })).status(),
      ).toBe(400);
    }
    expect(
      await request
        .patch(`/api/conversations/${fixture.id}`, { headers, data: { pinned: true } })
        .then((response) => response.json()),
    ).toMatchObject({ pinned: true, archived: false });
    const changed = await request.patch(`/api/conversations/${fixture.id}`, {
      headers,
      data: { title: '  改名后  ', pinned: true, archived: true },
    });
    expect(changed.status()).toBe(200);
    expect(await changed.json()).toMatchObject({
      title: '改名后',
      pinned: true,
      archived: true,
      updatedAt: fixture.created.updatedAt,
    });
    expect((await index(request)).conversations[0]).toMatchObject({
      id: fixture.id,
      pinned: true,
      archived: true,
    });
    expect(
      (
        await request.patch(`/api/conversations/${id}`, { headers, data: { title: '不存在' } })
      ).status(),
    ).toBe(404);
  } finally {
    await request.delete(`/api/conversations/${fixture.id}`, { headers });
    await fixture.restore();
  }
});

test('deleting a running conversation notifies subscribers, aborts generation, releases storage and rejects late submissions', async ({
  page,
  browser,
}) => {
  const fixture = await setup(page.request, 'alarm-stall');
  const input = {
    parentId: null,
    requestId: crypto.randomUUID(),
    content: '生成时删除',
  };
  const response = await page.request.post(`/api/conversations/${fixture.id}/messages`, {
    headers,
    data: input,
  });
  expect(response.status()).toBe(202);
  const other = await browser.newContext();
  let subscribed: Awaited<ReturnType<typeof subscribe>> | undefined;
  try {
    await page.goto(`/c/${fixture.id}`);
    await expect(page.getByTestId('assistant-message')).toContainText('等待上游的正文');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('尚未发送的草稿');
    expect((await other.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
    const second = await other.newPage();
    await second.goto(`/c/${fixture.id}`);
    await expect(second.getByTestId('assistant-message')).toContainText('等待上游的正文');
    subscribed = await subscribe(page.request, fixture.id);
    expect((await action(page.request, fixture.id, 'fill', { target: 8 * 1024 * 1024 })).ok()).toBe(
      true,
    );
    const removed = await other.request.delete(`/api/conversations/${fixture.id}`, { headers });
    expect(removed.status()).toBe(200);
    const { deletedAt } = await removed.json();
    await expect
      .poll(() =>
        subscribed!.packets.some(
          (packet) => packet.type === 'deleted' && packet.deletedAt === deletedAt,
        ),
      )
      .toBe(true);
    await expect.poll(() => subscribed!.closeCode()).toBe(4003);
    for (const client of [page, second]) {
      await expect(client.getByRole('alert')).toContainText('这个对话已删除');
      await expect(client.getByTestId('assistant-message')).toHaveCount(0);
      await expect(client.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
      expect(
        await client.evaluate(
          (id) => JSON.parse(localStorage.getItem(`everchat:snapshot:parts-v1:${id}`)!),
          fixture.id,
        ),
      ).toMatchObject({ messages: [], deletedAt });
      expect(
        await client.evaluate((id) => localStorage.getItem(`everchat:draft:${id}`), fixture.id),
      ).toBeNull();
    }
    const resources = await action(page.request, fixture.id, 'deletion-state').then((result) =>
      result.json(),
    );
    expect(resources).toMatchObject({
      messages: 0,
      runs: 0,
      journalRows: 0,
      events: 0,
      submissions: 0,
      alarmAt: null,
      deletedAt,
    });
    expect(resources.databaseBytes).toBeLessThan(256 * 1024);
    expect(await deletion(page.request, fixture.id)).toMatchObject({ calls: 1, deletedAt });
    expect((await index(page.request)).conversations.some((item) => item.id === fixture.id)).toBe(
      false,
    );
    expect((await page.request.get(`/api/conversations/${fixture.id}`)).status()).toBe(410);
    expect(
      (
        await page.request.post('/api/conversations', {
          headers,
          data: { id: fixture.id, title: '迟到的创建' },
        })
      ).status(),
    ).toBe(410);
    expect(
      (
        await page.request.post(`/api/conversations/${fixture.id}/messages`, {
          headers,
          data: input,
        })
      ).status(),
    ).toBe(410);
    expect(
      (
        await page.request.patch(`/api/conversations/${fixture.id}`, {
          headers,
          data: { pinned: true },
        })
      ).status(),
    ).toBe(410);
    expect(
      (
        await action(page.request, fixture.id, 'late-submit', { runId: crypto.randomUUID() })
      ).status(),
    ).toBe(410);
    expect(
      (
        await page.request
          .delete(`/api/conversations/${fixture.id}`, { headers })
          .then((result) => result.json())
      ).deletedAt,
    ).toBe(deletedAt);
    expect(await deletion(page.request, fixture.id)).toMatchObject({ calls: 1 });
  } finally {
    subscribed?.socket.terminate();
    await other.close();
    await page.request.delete(`/api/conversations/${fixture.id}`, { headers });
    await fixture.restore();
  }
});

test('the management menu preserves failed edits, syncs metadata to another device, and confirms deletion', async ({
  page,
  browser,
}) => {
  const fixture = await setup(page.request);
  const neighbor = crypto.randomUUID();
  const other = await browser.newContext();
  try {
    // A surviving sidebar row must not take focus from the new-chat composer on current deletion.
    expect(
      (
        await page.request.post('/api/conversations', {
          headers,
          data: { id: neighbor, title: 'Surviving neighbor' },
        })
      ).status(),
    ).toBe(201);
    await page.goto(`/c/${fixture.id}`);
    expect((await other.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
    const second = await other.newPage();
    await second.goto(`/c/${fixture.id}`);
    await expect(second.getByRole('banner')).toContainText(fixture.title);
    let failing = true;
    await page.route(`**/api/conversations/${fixture.id}`, async (route) => {
      if (route.request().method() === 'PATCH' && failing)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '保存失败，请重试。' }),
        });
      else await route.continue();
    });
    const menu = () => page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await menu();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名', exact: true }),
      input = dialog.getByRole('textbox', { name: '对话名称', exact: true });
    await expect(input).toBeFocused();
    await input.fill('重命名的对话');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('保存失败');
    await expect(input).toHaveValue('重命名的对话');
    failing = false;
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('banner')).toContainText('重命名的对话');
    await menu();
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await index(page.request)).conversations.find((item) => item.id === fixture.id)?.pinned,
      )
      .toBe(true);
    await menu();
    await page.getByRole('menuitem', { name: '归档', exact: true }).click();
    await expect(
      page.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toHaveCount(0);
    await expect(second.getByRole('banner')).toContainText('重命名的对话');
    await expect(
      second.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toHaveCount(0);
    await second.getByRole('tab', { name: '归档', exact: true }).click();
    await expect(
      second.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toBeVisible();
    await second.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await expect(second.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
    await expect(second.getByRole('menuitem', { name: '取消归档', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '归档', exact: true }).click();
    await expect(
      page.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole('banner')).toContainText('重命名的对话');
    await menu();
    await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
    await expect(
      page.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toBeVisible();
    await menu();
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await index(page.request)).conversations.find((item) => item.id === fixture.id)?.pinned,
      )
      .toBe(false);
    await menu();
    await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: '删除对话', exact: true });
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    expect((await page.request.get(`/api/conversations/${fixture.id}`)).status()).toBe(200);
    await menu();
    await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
    await confirmation.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
    await expect(
      page.locator('aside').getByRole('link', { name: '重命名的对话', exact: true }),
    ).toHaveCount(0);
  } finally {
    await other.close();
    await page.request.delete(`/api/conversations/${neighbor}`, { headers });
    await page.request.delete(`/api/conversations/${fixture.id}`, { headers });
    await fixture.restore();
  }
});

test('a device reconnects with a late outbox, clears an unselected deleted conversation and preserves another draft', async ({
  page,
  context,
  browser,
}) => {
  const fixture = await setup(page.request, 'alarm-test');
  const second = await browser.newContext();
  try {
    expect(
      (
        await page.request.post(`/api/conversations/${fixture.id}/messages`, {
          headers,
          data: { parentId: null, requestId: crypto.randomUUID(), content: '缓存后删除' },
        })
      ).status(),
    ).toBe(202);
    await expect
      .poll(
        async () =>
          (
            (await page.request
              .get(`/api/conversations/${fixture.id}`)
              .then((response) => response.json())) as Snapshot
          ).messages[1].status,
      )
      .toBe('completed');
    await page.goto(`/c/${fixture.id}`);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await context.setOffline(true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('迟到的离线消息');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
    await page.locator('aside').getByRole('button', { name: '开启新对话', exact: true }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留新对话的草稿');
    expect((await second.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
    expect(
      (await second.request.delete(`/api/conversations/${fixture.id}`, { headers })).status(),
    ).toBe(200);
    await context.setOffline(false);
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!)))
      .toEqual([]);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
      '保留新对话的草稿',
    );
    await expect(
      page.locator('aside').getByRole('link', { name: fixture.title, exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem(`everchat:snapshot:parts-v1:${id}`)!).messages.length,
          fixture.id,
        ),
      )
      .toBe(0);
    await page.goto(`/c/${fixture.id}`);
    await expect(page.getByRole('alert')).toContainText('这个对话已删除');
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    expect(await deletion(second.request, fixture.id)).toMatchObject({ calls: 1 });
  } finally {
    await context.setOffline(false);
    await second.close();
    await page.request.delete(`/api/conversations/${fixture.id}`, { headers });
    await fixture.restore();
  }
});

for (const fault of ['delete-failure', 'delete-reset'])
  test(`Library Alarm completes deletion after ${fault}, without starting a queued supplier call`, async ({
    request,
  }) => {
    const fixture = await setup(request, 'alarm-test');
    try {
      expect((await action(request, fixture.id, fault)).ok()).toBe(true);
      expect(
        (
          await request.post(`/api/conversations/${fixture.id}/messages`, {
            headers,
            data: { parentId: null, requestId: crypto.randomUUID(), content: '排队后删除' },
          })
        ).status(),
      ).toBe(202);
      expect((await request.delete(`/api/conversations/${fixture.id}`, { headers })).status()).toBe(
        500,
      );
      await expect
        .poll(async () => {
          const response = await action(request, fixture.id, 'deletion-state');
          return response.ok() ? (await response.json()).deletedAt : null;
        })
        .toBeTruthy();
      const state = await action(request, fixture.id, 'deletion-state').then((response) =>
        response.json(),
      );
      expect(state).toMatchObject({
        messages: 0,
        runs: 0,
        journalRows: 0,
        submissions: 0,
        alarmAt: null,
      });
      expect(await deletion(request, fixture.id)).toMatchObject({ calls: 0 });
      expect((await request.get(`/api/conversations/${fixture.id}`)).status()).toBe(410);
      expect(
        (
          await request.post('/api/conversations', {
            headers,
            data: { id: fixture.id, title: '迟到的客户端' },
          })
        ).status(),
      ).toBe(410);
      expect(
        (await action(request, fixture.id, 'late-submit', { runId: crypto.randomUUID() })).status(),
      ).toBe(410);
      expect((await request.delete(`/api/conversations/${fixture.id}`, { headers })).status()).toBe(
        200,
      );
    } finally {
      await request.delete(`/api/conversations/${fixture.id}`, { headers });
      await fixture.restore();
    }
  });

test('deletion synchronization pages markers without gaps or duplicates', async ({ request }) => {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const seed = (count: number) =>
    request.post('/api/__test/library/deletion-history', { headers, data: { count } });
  let before = await index(request);
  while (before.hasMoreDeletions)
    before = (await request
      .get(`/api/conversations?after=${before.deletionCursor}`)
      .then((response) => response.json())) as LibrarySnapshot;
  try {
    expect((await seed(300)).ok()).toBe(true);
    const first = (await request
      .get(`/api/conversations?after=${before.deletionCursor}`)
      .then((response) => response.json())) as LibrarySnapshot;
    expect(first.deletions).toHaveLength(256);
    expect(first.hasMoreDeletions).toBe(true);
    const second = (await request
      .get(`/api/conversations?after=${first.deletionCursor}`)
      .then((response) => response.json())) as LibrarySnapshot;
    expect(second.deletions).toHaveLength(44);
    expect(second.hasMoreDeletions).toBe(false);
    expect(new Set([...first.deletions, ...second.deletions].map((item) => item.id)).size).toBe(
      300,
    );
    expect(second.deletionCursor).toBeGreaterThan(first.deletionCursor);
    const done = (await request
      .get(`/api/conversations?after=${second.deletionCursor}`)
      .then((response) => response.json())) as LibrarySnapshot;
    expect(done.deletions).toHaveLength(0);
    expect(done.deletionCursor).toBe(second.deletionCursor);
  } finally {
    expect((await seed(0)).ok()).toBe(true);
  }
});
