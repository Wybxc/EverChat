import { expect, test, type APIRequestContext } from '@playwright/test';
import type { LibrarySnapshot, Submission } from '../../../shared/conversation/types';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
const headers = { Origin: 'http://127.0.0.1:5174' };
const chatModel = 'benchmark-text-20-20-32';
async function setup(
  request: APIRequestContext,
  automatic = true,
  titleModel = 'title-fixture-fast',
) {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    ids: string[] = [];
  let settings = {
    ...original,
    activeProviderId: providerId,
    activeModel: chatModel,
    title: { automatic, model: { providerId, model: titleModel } },
    providers: [
      {
        id: providerId,
        name: '标题供应商',
        provider: 'openai-chat' as const,
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        hasApiKey: true,
        models: [
          chatModel,
          'title-fixture-fast',
          'title-fixture-second',
          'title-fixture-slow',
          'title-fixture-error',
          'title-fixture-parallel',
        ].map((id) => ({ id, name: id, enabled: true })),
      },
    ],
  };
  const save = async (model = titleModel, auto = automatic) => {
    settings = { ...settings, title: { automatic: auto, model: { providerId, model } } };
    expect(
      (await request.put('/api/settings/providers', { headers, data: settings })).status(),
    ).toBe(200);
  };
  await save();
  const info = async (id: string) =>
    (
      (await request.get('/api/conversations').then((r) => r.json())) as LibrarySnapshot
    ).conversations.find((c) => c.id === id);
  const state = async (id: string) =>
    request
      .post(`/api/__test/conversations/${id}/titles`, { headers, data: {} })
      .then((r) => r.json()) as Promise<{
      calls: number;
      jobs: { id: string; state: string; retainsConfig: number }[];
    }>;
  const snapshot = async (id: string) =>
    request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
  const create = async (source: 'fallback' | null = 'fallback') => {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      (
        await request.post('/api/conversations', {
          headers,
          data: { id, title: '临时标题', titleSource: source ?? undefined },
        })
      ).status(),
    ).toBe(201);
    return id;
  };
  const send = async (id: string, retryOf?: string) => {
    const response = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        ...(retryOf ? { retryOf } : { parentId: null, content: '测试自动标题' }),
        selection: { providerId, model: chatModel },
      },
    });
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as Submission;
    await expect
      .poll(
        async () =>
          (await snapshot(id)).messages.find((m) => m.id === accepted.assistantId)?.status,
      )
      .toBe('completed');
    return accepted;
  };
  return {
    ids,
    settings,
    save,
    info,
    state,
    snapshot,
    create,
    send,
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('automatic naming uses its independent model once, preserves messages, and copies keep only the title', async ({
  request,
}) => {
  const s = await setup(request);
  try {
    const id = await s.create();
    const first = await s.send(id);
    await expect.poll(async () => (await s.info(id))?.title).toBe('独立生成的标题');
    expect((await s.info(id))?.titleSource).toBe('ai');
    expect((await s.snapshot(id)).messages).toHaveLength(2);
    await s.send(id, first.assistantId);
    expect((await s.state(id)).jobs).toHaveLength(1);
    expect((await s.state(id)).jobs[0].retainsConfig).toBe(0);
    expect((await s.state(id)).calls).toBe(1);
    const cloneId = crypto.randomUUID();
    s.ids.push(cloneId);
    const copy = await request.post(`/api/conversations/${id}/duplicate`, {
      headers,
      data: { requestId: cloneId },
    });
    expect(copy.status()).toBe(201);
    expect((await s.info(cloneId))?.title).toContain('独立生成的标题');
    expect((await s.state(cloneId)).jobs).toHaveLength(0);
    expect((await s.info(cloneId))?.titleTask).toBeUndefined();
    await s.send(cloneId, (await s.snapshot(cloneId)).messages.at(-1)!.id);
    expect((await s.state(cloneId)).jobs).toHaveLength(0);
    const backup = await request.get(`/api/conversations/${id}/backup`);
    expect(backup.ok()).toBe(true);
    const document = await backup.json();
    expect(document.settings.title).toEqual(s.settings.title);
    expect(JSON.stringify(document)).not.toContain('integration-test-key');
    expect(document.conversation.titleTask).toBeUndefined();
    const renamed = await s.create(null);
    await s.send(renamed);
    await expect.poll(async () => (await s.state(renamed)).jobs[0]?.state).toBe('superseded');
    expect((await s.info(renamed))?.title).toBe('临时标题');
  } finally {
    await s.cleanup();
  }
});

test('default-off naming makes no call, and settings enable the menu without changing the chat model', async ({
  page,
  request,
}) => {
  const s = await setup(page.request, false);
  try {
    const id = await s.create();
    await s.send(id);
    expect((await s.state(id)).jobs).toHaveLength(0);
    await page.goto(`/c/${id}`);
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('tab', { name: '对话', exact: true }).click();
    await settings.locator('summary').filter({ hasText: '自动标题' }).click();
    await expect(settings.getByLabel('标题模型', { exact: true })).toHaveValue(
      JSON.stringify([s.settings.activeProviderId, 'title-fixture-fast']),
    );
    await settings
      .getByLabel('标题模型', { exact: true })
      .selectOption(JSON.stringify([s.settings.activeProviderId, 'title-fixture-second']));
    await expect(settings.getByTestId('settings-save-status')).toHaveText('已保存');
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '生成标题', exact: true }).click();
    await expect.poll(async () => (await s.info(id))?.title).toBe('第二个模型的标题');
    expect((await s.snapshot(id)).messages).toHaveLength(2);
    expect((await s.snapshot(id)).messages.at(-1)?.model).toBe(chatModel);
  } finally {
    await s.cleanup();
  }
});

test('manual naming wins during execution, and an interrupted auxiliary call never auto-reissues', async ({
  request,
}) => {
  const s = await setup(request, false, 'title-fixture-slow');
  try {
    const id = await s.create();
    await s.send(id);
    const jobId = crypto.randomUUID();
    expect(
      (
        await request.post(`/api/conversations/${id}/title`, {
          headers,
          data: { requestId: jobId },
        })
      ).status(),
    ).toBe(202);
    await expect.poll(async () => (await s.state(id)).jobs[0]?.state).toBe('running');
    await request.patch(`/api/conversations/${id}`, { headers, data: { title: '手动优先' } });
    await expect.poll(async () => (await s.state(id)).jobs[0]?.state).toBe('superseded');
    expect((await s.info(id))?.title).toBe('手动优先');
    const secondId = crypto.randomUUID();
    await request.post(`/api/conversations/${id}/title`, {
      headers,
      data: { requestId: secondId },
    });
    await expect
      .poll(async () => (await s.state(id)).jobs.find((j) => j.id === secondId)?.state)
      .toBe('running');
    await request.post(`/api/__test/conversations/${id}/titles-reset`, { headers, data: {} });
    await expect
      .poll(async () => (await s.state(id)).jobs.find((j) => j.id === secondId)?.state)
      .toBe('failed');
    expect((await s.info(id))?.title).toBe('手动优先');
    expect((await s.info(id))?.titleTask?.error).toContain('重复计费');
    expect((await s.state(id)).calls).toBeLessThanOrEqual(2);
  } finally {
    await s.cleanup();
  }
});

test('a failed title retains the fallback and unavailable title models never fall back to chat', async ({
  request,
}) => {
  const s = await setup(request, true, 'title-fixture-error');
  try {
    const id = await s.create();
    await s.send(id);
    await expect.poll(async () => (await s.state(id)).jobs[0]?.state).toBe('failed');
    expect((await s.info(id))?.title).toBe('临时标题');
    await s.save('removed-title-model');
    const response = await request.post(`/api/conversations/${id}/title`, {
      headers,
      data: { requestId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(400);
    expect((await s.state(id)).jobs).toHaveLength(1);
    expect((await s.snapshot(id)).messages).toHaveLength(2);
    const backup = await request.get(`/api/conversations/${id}/backup`);
    expect(backup.ok()).toBe(true);
    expect(JSON.stringify(await backup.json())).not.toContain('integration-test-key');
  } finally {
    await s.cleanup();
  }
});

test('new chat generation starts while an auxiliary title runs, and pinning keeps its accepted result', async ({
  request,
}) => {
  const s = await setup(request, false, 'title-fixture-parallel');
  try {
    const id = await s.create(),
      first = await s.send(id);
    await request.post(`/api/conversations/${id}/title`, {
      headers,
      data: { requestId: crypto.randomUUID() },
    });
    await expect.poll(async () => (await s.state(id)).jobs[0]?.state).toBe('running');
    await s.send(id, first.assistantId);
    expect((await s.state(id)).jobs[0]?.state).toBe('running');
    expect((await s.snapshot(id)).messages).toHaveLength(3);
    const index = (await request
      .get('/api/conversations')
      .then((r) => r.json())) as LibrarySnapshot;
    expect(index.activity[id]?.status).toBe('idle');
    await request.patch(`/api/conversations/${id}`, { headers, data: { pinned: true } });
    await expect.poll(async () => (await s.info(id))?.title).toBe('独立生成的标题');
    expect((await s.info(id))?.pinned).toBe(true);
  } finally {
    await s.cleanup();
  }
});
