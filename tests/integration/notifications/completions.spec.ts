import { expect, test, type APIRequestContext } from '@playwright/test';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { NotificationDevice } from '../../../shared/notifications/protocol';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function fixture(request: APIRequestContext, model = 'test-model') {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    device: NotificationDevice = {
      instanceId: crypto.randomUUID(),
      revision: 1,
      mode: 'always',
      subscription: {
        endpoint: 'https://web.push.apple.com/test',
        expirationTime: null,
        keys: { auth: 'a'.repeat(22), p256dh: 'a'.repeat(87) },
      },
    };
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: '通知测试',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: model,
                  name: model,
                  enabled: true,
                  metadataOverrides: { toolCalls: true, contextWindow: 131072 },
                },
              ],
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
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: '完成通知' } })
    ).status(),
  ).toBe(201);
  expect((await request.put('/api/notifications/device', { headers, data: device })).ok()).toBe(
    true,
  );
  const report = () =>
    request
      .post('/api/__test/library/notifications', { headers, data: {} })
      .then((r) => r.json()) as Promise<{
      pushes: { device: string; completionId: string; payload: string }[];
      pending: { id: string; device: string; done: number }[];
    }>;
  const pushes = async () =>
    (await report()).pushes.filter((item) => item.device === device.instanceId);
  const snapshot = () =>
    request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
  const submit = async (data: object) => {
    const response = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        ...('retryOf' in data || 'summaryThrough' in data ? {} : { parentId: null }),
        ...data,
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    return response.json();
  };
  return {
    id,
    device,
    submit,
    snapshot,
    pushes,
    report,
    cleanup: async () => {
      await request.put('/api/notifications/device', {
        headers,
        data: { ...device, revision: 3, mode: 'never', subscription: null },
      });
      await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    },
  };
}
test('persisted ordinary answers and regenerated versions notify once, while historical reads and duplicate completion reports do not', async ({
  request,
}) => {
  const f = await fixture(request);
  try {
    await f.submit({ content: '普通回答通知' });
    await expect.poll(async () => (await f.snapshot()).messages[1]?.status).toBe('completed');
    await expect
      .poll(async () => ({
        count: (await f.pushes()).length,
        state: await request
          .post(`/api/__test/conversations/${f.id}/resources`, { headers, data: {} })
          .then((r) => r.json()),
      }))
      .toMatchObject({ count: 1 });
    const message = (await f.snapshot()).messages[1],
      first = (await f.pushes())[0];
    expect(JSON.parse(first.payload)).toMatchObject({
      conversationId: f.id,
      messageId: message.id,
    });
    expect(first.payload).not.toMatch(/content|parts|reasoning|apiKey/);
    for (let i = 0; i < 3; i++) await f.snapshot();
    await request.post('/api/__test/library/notifications', {
      headers,
      data: { completion: JSON.parse(first.payload) },
    });
    expect(await f.pushes()).toHaveLength(1);
    await f.submit({ retryOf: message.id });
    await expect.poll(async () => (await f.pushes()).length).toBe(2);
    expect(new Set((await f.pushes()).map((item) => item.completionId)).size).toBe(2);
  } finally {
    await f.cleanup();
  }
});
test('concurrent focus confirmations suppress both answers over a real notification socket, then background delivery resumes', async ({
  request,
}) => {
  const f = await fixture(request);
  let socket: WebSocket | undefined;
  try {
    expect(
      (
        await request.put('/api/notifications/device', {
          headers,
          data: { ...f.device, revision: 2, mode: 'unfocused' },
        })
      ).ok(),
    ).toBe(true);
    const cookies = (await request.storageState()).cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    socket = new WebSocket(
      `ws://127.0.0.1:5174/api/notifications/sync?instance=${f.device.instanceId}`,
      { headers: { ...headers, Cookie: cookies } },
    );
    const checks: string[] = [];
    let foreground = true;
    socket.on('message', (data) => {
      const packet = JSON.parse(data.toString()) as { type: string; id: string };
      if (packet.type !== 'check') return;
      if (!foreground) {
        socket!.send(JSON.stringify({ type: 'check', id: packet.id, foreground: false }));
        return;
      }
      checks.push(packet.id);
      if (checks.length === 2)
        for (const id of [...checks].reverse())
          socket!.send(JSON.stringify({ type: 'check', id, foreground: true }));
    });
    await once(socket, 'open');
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request.post('/api/__test/library/notifications', {
            headers,
            data: {
              completion: {
                conversationId: f.id,
                messageId: crypto.randomUUID(),
                completedAt: Date.now(),
              },
            },
          })
        ).ok(),
      ).toBe(true);
    await expect
      .poll(async () =>
        (await f.report()).pending
          .filter((item) => item.device === f.device.instanceId)
          .map((item) => item.done),
      )
      .toEqual([1, 1]);
    expect(checks).toHaveLength(2);
    expect(await f.pushes()).toHaveLength(0);
    foreground = false;
    await f.submit({ content: '切到后台后正常通知' });
    await expect.poll(async () => (await f.pushes()).length).toBe(1);
  } finally {
    socket?.close(1000, 'Test complete');
    await f.cleanup();
  }
});
test('failed provider answers do not enter the completion outbox', async ({ request }) => {
  const f = await fixture(request, 'diagnostic-http');
  try {
    await f.submit({ content: '失败不发成功通知' });
    await expect.poll(async () => (await f.snapshot()).messages[1]?.status).toBe('failed');
    expect(await f.pushes()).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
test('tool execution and model continuation produce a single notification for the final public answer', async ({
  request,
}) => {
  const f = await fixture(request, 'tools-openai-chat');
  try {
    await f.submit({ content: '查询文档', tools: ['web_search', 'read_webpage'] });
    await expect.poll(async () => (await f.snapshot()).messages[1]?.tools?.round).toBe(1);
    const during = (await f.snapshot()).messages[1];
    if (during.status === 'running') expect(await f.pushes()).toHaveLength(0);
    await expect.poll(async () => (await f.snapshot()).messages[1]?.status).toBe('completed');
    await expect.poll(async () => (await f.pushes()).length).toBe(1);
    expect((await f.snapshot()).messages).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test('manual answer revisions and context summaries do not notify', async ({ request }) => {
  const f = await fixture(request);
  try {
    await f.submit({ content: '先生成一条普通回答' });
    await expect.poll(async () => (await f.pushes()).length).toBe(1);
    const answer = (await f.snapshot()).messages[1];
    expect(
      (
        await request.patch(`/api/conversations/${f.id}/messages/${answer.id}`, {
          headers,
          data: { requestId: crypto.randomUUID(), content: '手动修改内容' },
        })
      ).status(),
    ).toBe(201);
    expect(await f.pushes()).toHaveLength(1);
    await f.submit({ summaryThrough: answer.id });
    await expect
      .poll(async () => (await f.snapshot()).messages.find((message) => message.summary)?.status)
      .toBe('completed');
    expect(await f.pushes()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test('cancelled answers do not notify', async ({ request }) => {
  const f = await fixture(request, 'alarm-test');
  try {
    const task = (await f.submit({ content: '停止后不通知' })) as { runId: string };
    expect(
      (
        await request.post(`/api/conversations/${f.id}/cancel`, {
          headers,
          data: { runId: task.runId },
        })
      ).ok(),
    ).toBe(true);
    await expect.poll(async () => (await f.snapshot()).messages[1]?.status).toBe('cancelled');
    expect(await f.pushes()).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('notification APIs require authentication, same-origin writes and valid subscriptions', async ({
  request,
  playwright,
}) => {
  const f = await fixture(request);
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    expect((await anonymous.get('/api/notifications/config')).status()).toBe(401);
    // An unread anonymous request body can poison Vite's internal workerd connection.
    expect((await anonymous.put('/api/notifications/device', { headers })).status()).toBe(401);
    expect((await request.put('/api/notifications/device')).status()).toBe(403);
    const invalid = await request.put('/api/notifications/device', {
      headers,
      data: {
        ...f.device,
        subscription: {
          ...f.device.subscription!,
          keys: { auth: 'sensitive-fixture', p256dh: 'invalid' },
        },
      },
    });
    expect(invalid.status()).toBe(400);
    const diagnostic = await invalid.json();
    expect(diagnostic.code).toBe('INVALID_NOTIFICATION_DEVICE');
    expect(diagnostic.error).toContain('subscription.keys.auth');
    expect(diagnostic.error).not.toContain('sensitive-fixture');
    const { expirationTime: _expiry, ...withoutExpiry } = f.device.subscription!;
    const normalized = await request.put('/api/notifications/device', {
      headers,
      data: { ...f.device, revision: 2, subscription: withoutExpiry },
    });
    expect(normalized.status()).toBe(200);
    expect((await normalized.json()).subscription.expirationTime).toBeNull();
    expect(
      (
        await request.put('/api/notifications/device', {
          headers,
          data: {
            ...f.device,
            revision: 3,
            subscription: {
              ...f.device.subscription!,
              endpoint: 'https://untrusted.example.com/push',
            },
          },
        })
      ).status(),
    ).toBe(400);
  } finally {
    await anonymous.dispose();
    await f.cleanup();
  }
});
