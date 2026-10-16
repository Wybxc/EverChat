import { expect, test, type APIRequestContext } from '@playwright/test';
import { messageText } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind, ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(
  request: APIRequestContext,
  provider: ProviderKind = 'openai-chat',
  options: {
    fault?: string;
    loop?: boolean;
    contextBudget?: number;
    pauseModel?: boolean;
    requestId?: string;
  } = {},
) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const id = crypto.randomUUID(),
    providerId = crypto.randomUUID(),
    model = `tools-${options.loop ? 'loop-' : options.pauseModel ? 'pause-' : ''}${provider}`;
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Tool fixture',
              provider,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: model,
                  name: model,
                  enabled: true,
                  reasoningSupport: 'supported',
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
      await request.post('/api/conversations', {
        headers,
        data: { id, title: 'Native tool workflow' },
      })
    ).status(),
  ).toBe(201);
  const input = {
    parentId: null,
    requestId: options.requestId ?? crypto.randomUUID(),
    content: '查询 Cloudflare 文档',
    tools: ['web_search', 'read_webpage'],
    ...(options.contextBudget
      ? { settings: { ...DEFAULT_CONVERSATION_SETTINGS, contextBudget: options.contextBudget } }
      : {}),
  };
  if (options.fault)
    expect(
      (
        await request.post(`/api/__test/conversations/${id}/tool-runtime`, {
          headers,
          data: { taskId: input.requestId, fault: options.fault },
        })
      ).ok(),
    ).toBe(true);
  const response = await request.post(`/api/conversations/${id}/messages`, {
    headers,
    data: input,
  });
  expect(response.status(), await response.text()).toBe(202);
  const submission = (await response.json()) as Submission;
  const snapshot = () =>
    request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json()) as Promise<Snapshot>;
  const state = (control: { expire?: boolean } = {}) =>
    request
      .post(`/api/__test/conversations/${id}/tool-runtime`, {
        headers,
        data: { taskId: input.requestId, ...control },
      })
      .then(async (response) => {
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      });
  const cleanup = async () => {
    expect((await request.delete(`/api/conversations/${id}`, { headers })).ok()).toBe(true);
    expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
      true,
    );
  };
  return { id, input, submission, snapshot, state, cleanup };
}

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} native Workflow completes a durable model-tool-model exchange without a connected client`, async ({
    request,
  }) => {
    const f = await setup(request, provider);
    try {
      await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
      const snapshot = await f.snapshot(),
        answer = snapshot.messages[1];
      expect(snapshot.messages).toHaveLength(2);
      expect(answer.runId).not.toBe(f.submission.runId);
      expect(messageText(answer)).toBe(
        (provider === 'openai-chat' ? '先查阅资料。\n' : '') + '**工具回答🙂**\n结论。',
      );
      expect(answer.tools).toMatchObject({ status: 'completed', round: 1 });
      expect(answer.tools!.calls.map((item) => item.state)).toEqual(['completed', 'completed']);
      expect(answer.generation).toMatchObject({
        usage: { inputTokens: 15, outputTokens: 8 },
        usageIsFinal: provider === 'anthropic' || provider === 'gemini',
      });
      expect(answer.generation!.context!.toolTokens).toBeGreaterThan(2048);
      expect(answer.generation!.context!.totalTokens).toBeGreaterThan(2200);
      expect(answer.generation!.timing!.durationMs).toBeGreaterThanOrEqual(5000);
      await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
      expect(await f.state()).toMatchObject({
        privatePayloads: 0,
        modelCalls: 2,
        toolCalls: 2,
        state: { modelRequests: 2, toolRequests: 2 },
      });
      const duplicate = await request.post(`/api/conversations/${f.id}/messages`, {
        headers,
        data: f.input,
      });
      expect(duplicate.status()).toBe(202);
      expect(await duplicate.json()).toEqual(f.submission);
      expect(await f.snapshot()).toEqual(snapshot);
      expect((await f.state()).modelCalls).toBe(2);
      const configured = (await request
        .get('/api/settings/providers')
        .then((response) => response.json())) as ProviderSettings;
      for (const profile of configured.providers)
        for (const model of profile.models)
          model.metadataOverrides = { ...model.metadataOverrides, toolCalls: false };
      expect(
        (await request.put('/api/settings/providers', { headers, data: configured })).ok(),
      ).toBe(true);
      const rejected = await request.post(`/api/conversations/${f.id}/messages`, {
        headers,
        data: {
          ...f.input,
          parentId: snapshot.messages.at(-1)!.id,
          requestId: crypto.randomUUID(),
        },
      });
      expect(rejected.status()).toBe(400);
      expect(await rejected.json()).toEqual({ error: '当前模型不支持工具调用。' });
      expect(await f.snapshot()).toEqual(snapshot);
      expect((await f.state()).modelCalls).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

test('the same request ID in different conversations creates independent native Workflows', async ({
  request,
}) => {
  const requestId = crypto.randomUUID(),
    first = await setup(request, 'openai-chat', { requestId });
  try {
    const second = await setup(request, 'openai-chat', { requestId });
    try {
      for (const f of [first, second]) {
        await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
        await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
        expect(await f.state()).toMatchObject({
          modelCalls: 2,
          toolCalls: 2,
          privatePayloads: 0,
          privateStreams: 0,
        });
      }
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
  }
});

for (const fault of ['create-lost', 'event-once'])
  test(`native Workflow ${fault} recovers without restarting a model request`, async ({
    request,
  }) => {
    const f = await setup(request, 'openai-chat', { fault });
    try {
      await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
      await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
      expect(await f.state()).toMatchObject({
        modelCalls: 2,
        toolCalls: 2,
        privatePayloads: 0,
        privateStreams: 0,
      });
    } finally {
      await f.cleanup();
    }
  });

test('resetting the DO during a tool request saves an interruption result and resumes the Workflow without another tool fetch', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    await expect
      .poll(async () => (await f.snapshot()).messages[1].tools?.calls[0]?.state)
      .toBe('running');
    expect(
      (
        await request.post(`/api/__test/conversations/${f.id}/abort`, {
          headers,
          data: { runId: f.submission.runId },
        })
      ).status(),
    ).toBe(503);
    await f.snapshot();
    await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
    expect((await f.snapshot()).messages[1].tools!.calls.map((item) => item.state)).toEqual([
      'failed',
      'completed',
    ]);
    expect(await f.state()).toMatchObject({
      modelCalls: 2,
      toolCalls: 2,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('resetting a claimed tool model preserves its display prefix, fails the root and wakes Workflow without repeating the model', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', { pauseModel: true });
  try {
    await expect
      .poll(async () => messageText((await f.snapshot()).messages[1]))
      .toContain('先查阅资料。');
    expect(
      (
        await request.post(`/api/__test/conversations/${f.id}/abort`, {
          headers,
          data: { runId: f.submission.runId },
        })
      ).status(),
    ).toBe(503);
    await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('failed');
    await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
    expect(messageText((await f.snapshot()).messages[1])).toContain('先查阅资料。');
    expect(await f.state()).toMatchObject({
      modelCalls: 1,
      toolCalls: 0,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('native context budget stops after saved tool results and never starts a second model', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', { contextBudget: 2200 });
  try {
    await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('failed');
    expect((await f.snapshot()).messages[1].error).toContain('上下文预算');
    expect(await f.state()).toMatchObject({
      modelCalls: 1,
      toolCalls: 2,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('native round budget stops after four models and six tools with the unexecuted calls recorded as failures', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', { loop: true });
  try {
    await expect
      .poll(async () => (await f.snapshot()).messages[1].status, { timeout: 40_000 })
      .toBe('failed');
    const answer = (await f.snapshot()).messages[1];
    expect(answer.error).toContain('轮数');
    expect(answer.tools!.calls).toHaveLength(8);
    expect(answer.tools!.calls.slice(-2).every((call) => call.state === 'failed')).toBe(true);
    expect(await f.state()).toMatchObject({
      modelCalls: 4,
      toolCalls: 6,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('tool process sync survives page closure and a second device, with no private continuation in frames or caches', async ({
  page,
  context,
  browser,
}) => {
  const f = await setup(context.request, 'anthropic'),
    frames: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => frames.push(String(payload))),
  );
  const second = await browser.newContext({ storageState: await context.storageState() });
  try {
    await page.goto(`/c/${f.id}`);
    await expect(page.getByTestId('tool-activity')).toContainText('执行中');
    await page.close();
    await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
    const other = await second.newPage();
    await other.goto(`/c/${f.id}`);
    await expect(other.getByTestId('assistant-message')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await other.getByTestId('tool-activity').locator(':scope > summary').click();
    await expect(other.getByTestId('tool-activity').getByRole('link')).toHaveCount(2);
    await other
      .getByTestId('assistant-message')
      .getByRole('button', { name: '生成信息', exact: true })
      .click();
    await expect(other.getByTestId('generation-toolTokens')).toBeVisible();
    await other
      .getByRole('dialog', { name: '生成信息', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(other.getByRole('dialog', { name: '生成信息', exact: true })).toHaveCount(0);
    await other.keyboard.press('Escape');
    await expect(other.getByRole('menu')).toHaveCount(0);
    expect(
      await other.getByTestId('tool-activity').getByRole('link').first().getAttribute('href'),
    ).toBe('https://developers.cloudflare.com/');
    const cached = await other.evaluate(
      (id) => localStorage.getItem(`everchat:snapshot:parts-v1:${id}`),
      f.id,
    );
    expect(cached).toBeTruthy();
    expect(cached).not.toMatch(
      /fixture-signature|encrypted-fixture|redacted-fixture|providerOptions/,
    );
    for (const frame of frames) {
      expect(frame).not.toMatch(/fixture-signature|encrypted-fixture|redacted-fixture/);
      if (frame === 'pong') continue;
      const packet = JSON.parse(frame);
      for (const batch of packet.batches ?? (packet.batch ? [packet.batch] : []))
        expect(Buffer.from(batch.data, 'base64').toString()).not.toMatch(
          /signature|encrypted_content|redacted_thinking/,
        );
    }
    expect(await f.state()).toMatchObject({
      modelCalls: 2,
      toolCalls: 2,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await second.close();
    await f.cleanup();
  }
});

test('stopping during a native Workflow tool request prevents continuation even with the first model run ID', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    await expect
      .poll(async () => (await f.snapshot()).messages[1].tools?.calls[0]?.state)
      .toBe('running');
    expect(
      (
        await request.post(`/api/conversations/${f.id}/cancel`, {
          headers,
          data: { runId: f.submission.runId },
        })
      ).ok(),
    ).toBe(true);
    expect((await f.snapshot()).messages[1]).toMatchObject({
      status: 'cancelled',
      tools: { status: 'cancelled' },
    });
    await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
    expect(await f.state()).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      privatePayloads: 0,
      state: { status: 'cancelled', modelRequests: 1 },
    });
  } finally {
    await f.cleanup();
  }
});

test('expiring a root during a tool request saves an explicit failure and prevents the next model', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    await expect
      .poll(async () => (await f.snapshot()).messages[1].tools?.calls[0]?.state)
      .toBe('running');
    expect((await f.state({ expire: true })).state.status).toBe('failed');
    const answer = (await f.snapshot()).messages[1];
    expect(answer.status).toBe('failed');
    expect(answer.error).toContain('期限');
    await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
    expect(await f.state()).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('the original run ID can stop a later streaming model round without losing earlier results', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', { pauseModel: true });
  try {
    await expect
      .poll(async () => {
        const answer = (await f.snapshot()).messages[1];
        return answer.tools?.round === 1 && answer.status === 'running';
      })
      .toBe(true);
    expect(
      (
        await request.post(`/api/conversations/${f.id}/cancel`, {
          headers,
          data: { runId: f.submission.runId },
        })
      ).ok(),
    ).toBe(true);
    const answer = (await f.snapshot()).messages[1];
    expect(answer).toMatchObject({ status: 'cancelled', tools: { status: 'cancelled', round: 1 } });
    expect(answer.tools!.calls.every((item) => item.state === 'completed')).toBe(true);
    expect(messageText(answer)).toContain('先查阅资料。');
    await expect.poll(async () => (await f.state()).workflow?.status).toBe('complete');
    expect(await f.state()).toMatchObject({
      modelCalls: 2,
      toolCalls: 2,
      privatePayloads: 0,
      privateStreams: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('tool results survive independent copy and backup restore, and message deletion erases the public process', async ({
  request,
}) => {
  const f = await setup(request, 'openai-responses'),
    copies: string[] = [];
  try {
    await expect.poll(async () => (await f.snapshot()).messages[1].status).toBe('completed');
    const answer = (await f.snapshot()).messages[1];
    const duplicate = await request.post(`/api/conversations/${f.id}/duplicate`, {
      headers,
      data: { requestId: crypto.randomUUID() },
    });
    expect(duplicate.status()).toBe(201);
    const copied = (await duplicate.json()) as { id: string; snapshot: Snapshot };
    copies.push(copied.id);
    expect(copied.snapshot.messages[1].tools).toEqual(answer.tools);
    expect(copied.snapshot.messages[1].generation).toEqual(answer.generation);
    expect(copied.snapshot.messages[1].runId).toBeNull();
    const backup = await request
      .get(`/api/conversations/${f.id}/backup`)
      .then((response) => response.json());
    expect(JSON.stringify(backup)).not.toMatch(
      /encrypted-fixture|redacted-fixture|fixture-signature|integration-test-key|providerOptions/,
    );
    const imported = await request.post('/api/backup/restore', { headers, data: backup });
    expect(imported.status()).toBe(201);
    const restored = (await imported.json()) as { id: string; snapshot: Snapshot };
    copies.push(restored.id);
    expect(restored.snapshot.messages[1].tools).toEqual(answer.tools);
    expect(restored.snapshot.messages[1].runId).toBeNull();
    expect(restored.snapshot.messages[1].generation).toEqual(answer.generation);
    expect(
      (await request.delete(`/api/conversations/${f.id}/messages/${answer.id}`, { headers })).ok(),
    ).toBe(true);
    const deleted = (await f.snapshot()).messages[1];
    expect(deleted.tools).toBeUndefined();
    expect(deleted.parts).toEqual([]);
    expect((await f.state()).state.status).toBe('cancelled');
    for (const id of copies) {
      const snapshot = (await request
        .get(`/api/conversations/${id}`)
        .then((response) => response.json())) as Snapshot;
      expect(snapshot.messages[1].tools).toEqual(answer.tools);
    }
  } finally {
    for (const id of copies) await request.delete(`/api/conversations/${id}`, { headers });
    await f.cleanup();
  }
});
