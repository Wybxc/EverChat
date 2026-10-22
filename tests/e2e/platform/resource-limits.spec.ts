import { expect, test, type APIRequestContext } from '@playwright/test';
import { messageText } from '../../../shared/conversation/content';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { STORAGE_QUOTA_MESSAGE } from '../../../worker/platform/resource-limits';
const headers = { Origin: 'http://127.0.0.1:5174' };
const action = (request: APIRequestContext, id: string, name: string, data: unknown = {}) =>
  request.post(`/api/__test/conversations/${id}/${name}`, { headers, data });
async function setup(request: APIRequestContext) {
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
              name: 'Capacity fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: 'alarm-test',
                  name: 'Capacity fixture',
                  enabled: true,
                  reasoningSupport: 'supported',
                },
              ],
            },
          ],
          activeProviderId: providerId,
          activeModel: 'alarm-test',
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  const id = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: 'Capacity test' } })
    ).status(),
  ).toBe(201);
  return {
    id,
    restore: async () => {
      expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
        true,
      );
    },
  };
}

test('large unrelated branches no longer reject generation at four MiB of history', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'history', { pairs: 16 })).ok()).toBe(true);
    const before = (await request
      .get(`/api/conversations/${fixture.id}`)
      .then((response) => response.json())) as Snapshot;
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: {
        parentId: before.messages.at(-1)!.id,
        requestId: crypto.randomUUID(),
        content: '从所选分支继续',
      },
    });
    expect(response.status()).toBe(202);
    const accepted = await response.json();
    await request.post(`/api/conversations/${fixture.id}/cancel`, {
      headers,
      data: { runId: accepted.runId },
    });
    const after = (await request
      .get(`/api/conversations/${fixture.id}`)
      .then((result) => result.json())) as Snapshot;
    expect(after.messages).toHaveLength(34);
    expect(after.messages.slice(0, 32)).toEqual(before.messages);
    const stats = await request
      .get(`/api/conversations/${fixture.id}/storage`)
      .then((result) => result.json());
    expect(stats.canonicalBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(stats.idempotencyBytes).toBeLessThan(1024);
    await test.info().attach('storage-accounting', {
      body: JSON.stringify(stats),
      contentType: 'application/json',
    });
  } finally {
    await fixture.restore();
  }
});

test('generation remains usable above the previous per-conversation database budget', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'fill', { target: 33 * 1024 * 1024 })).ok()).toBe(
      true,
    );
    const input = { parentId: null, requestId: crypto.randomUUID(), content: '继续生成' };
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: input,
    });
    expect(response.status()).toBe(202);
    const accepted = await response.json();
    const snapshot = () =>
      request
        .get(`/api/conversations/${fixture.id}`)
        .then((result) => result.json()) as Promise<Snapshot>;
    await expect
      .poll(async () => (await snapshot()).messages[1]?.status, { timeout: 30_000 })
      .toBe('completed');
    expect(messageText((await snapshot()).messages[1])).toContain('服务端生成完成');
    const repeated = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: input,
    });
    expect(await repeated.json()).toEqual(accepted);
    expect(
      (await action(request, fixture.id, 'resources').then((result) => result.json())).calls,
    ).toBe(1);
  } finally {
    await fixture.restore();
  }
});

test('Library creates conversations beyond 128 and preserves idempotent retries', async ({
  request,
}) => {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const capacity = (seed: boolean) =>
    request.post('/api/__test/library/capacity', { headers, data: { seed } });
  let createdId: string | undefined;
  try {
    expect(await capacity(true).then((response) => response.json())).toEqual({
      count: 128,
    });
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    const responses = await Promise.all(
      ids.map((id) =>
        request.post('/api/conversations', {
          headers,
          data: { id, title: '__capacity_fixture__' },
        }),
      ),
    );
    expect(responses.filter((response) => response.status() === 201)).toHaveLength(12);
    expect(responses.filter((response) => response.status() === 507)).toHaveLength(0);
    const index = responses.findIndex((response) => response.status() === 201);
    createdId = ids[index];
    const repeated = await request.post('/api/conversations', {
      headers,
      data: { id: ids[index], title: '__capacity_fixture__' },
    });
    expect(repeated.status()).toBe(201);
    expect((await repeated.json()).id).toBe(ids[index]);
    expect(
      await request
        .get('/api/conversations')
        .then((response) => response.json())
        .then((items) => items.conversations.length),
    ).toBe(140);
  } finally {
    expect((await capacity(false)).ok()).toBe(true);
    if (createdId) {
      const search = await request
        .post('/api/__test/library/search', { headers, data: { id: createdId } })
        .then((response) => response.json());
      expect(search.progress).toBeNull();
    }
  }
});

test('a conversation with over 1,000 messages can still accept another generation', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'indexed-history', { count: 1001 })).ok()).toBe(true);
    const before = (await request
      .get(`/api/conversations/${fixture.id}`)
      .then((result) => result.json())) as Snapshot;
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: {
        parentId: before.messages[0].id,
        requestId: crypto.randomUUID(),
        content: '继续所选分支',
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await request
              .get(`/api/conversations/${fixture.id}/storage`)
              .then((result) => result.json())
          ).messages,
      )
      .toBe(1003);
  } finally {
    await fixture.restore();
  }
});

test('a native storage error crosses RPC as a sanitized 507 response', async ({ request }) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'storage-error')).ok()).toBe(true);
    const response = await request.get(`/api/conversations/${fixture.id}`);
    expect(response.status()).toBe(507);
    expect(await response.json()).toEqual({
      error: STORAGE_QUOTA_MESSAGE,
      issue: { code: 'STORAGE_FULL' },
    });
  } finally {
    await fixture.restore();
  }
});

test('a storage sync error is visible, pauses automatic retries and supports manual recovery', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  let failing = true,
    reads = 0;
  await page.route(
    (url) => url.pathname === `/api/conversations/${fixture.id}`,
    async (route) => {
      reads++;
      if (failing)
        await route.fulfill({
          status: 507,
          contentType: 'application/json',
          body: JSON.stringify({ error: STORAGE_QUOTA_MESSAGE }),
        });
      else await route.continue();
    },
  );
  try {
    await page.goto('/');
    await page
      .locator('aside')
      .getByRole('link', { name: 'Capacity test', exact: true })
      .first()
      .click();
    await expect(page.getByRole('alert')).toContainText('云端存储容量不足');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留草稿');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    const stopped = reads;
    await page.waitForTimeout(2000);
    expect(reads).toBe(stopped);
    failing = false;
    await page.getByRole('button', { name: '重新同步', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留草稿');
  } finally {
    await fixture.restore();
  }
});
