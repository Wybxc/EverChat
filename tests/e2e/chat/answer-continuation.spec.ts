import { expect, test } from '@playwright/test';
import { messageText } from '../../../shared/conversation/content';
import { localAnswerText } from '../../../shared/conversation/continuation';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('continuing creates a composed sibling, preserves drafts, and sends the visible answer on the next turn', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    model = 'metadata-reasoning';
  let copyId: string | undefined;
  const snapshot = () =>
    page.request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
  try {
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            ...original,
            activeProviderId: providerId,
            activeModel: model,
            providers: [
              {
                id: providerId,
                name: 'Continuation fixture',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [
                  {
                    id: model,
                    name: 'Continue model',
                    enabled: true,
                    reasoningSupport: 'supported',
                  },
                ],
              },
            ],
          },
        })
      ).ok(),
    ).toBe(true);
    await page.request.post('/api/conversations', { headers, data: { id, title: '继续测试' } });
    const first = await page.request
      .post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: null, content: '请回答原问题' },
      })
      .then((r) => r.json());
    await expect
      .poll(async () => (await snapshot()).messages.find((m) => m.id === first.assistantId)?.status)
      .toBe('completed');
    const source = (await snapshot()).messages.find((m) => m.id === first.assistantId)!;
    await page.goto(`/c/${id}?branch=${source.id}`);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('保留未发送草稿');
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/conversations/${id}/messages`),
    );
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '更多消息操作' })
      .click();
    await page.getByRole('menuitem', { name: '继续生成' }).click();
    const acceptedResponse = await response;
    expect(acceptedResponse.status()).toBe(202);
    const accepted = await acceptedResponse.json();
    const run = await page.request
      .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId: accepted.runId } })
      .then((r) => r.json());
    expect(
      run.context.map(({ role, content }: { role: string; content: string }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: 'user', content: '请回答原问题' },
      { role: 'assistant', content: messageText(source) },
      { role: 'user', content: '继续' },
    ]);
    expect(acceptedResponse.request().postDataJSON()).toMatchObject({ continueOf: source.id });
    expect(acceptedResponse.request().postDataJSON().content).toBeUndefined();
    await expect(editor).toHaveValue('保留未发送草稿');
    await expect
      .poll(
        async () => (await snapshot()).messages.find((m) => m.id === accepted.assistantId)?.status,
      )
      .toBe('completed');
    const state = await snapshot(),
      combined = state.messages.find((m) => m.id === accepted.assistantId)!;
    expect(messageText(combined)).toBe(messageText(source) + messageText(source));
    expect(combined).toMatchObject({
      parentId: first.userId,
      revisionOf: source.id,
      continuation: { sourceId: source.id, prefixTextLength: messageText(source).length },
    });
    expect(state.messages.find((m) => m.id === source.id)).toEqual(source);
    await expect(page).toHaveURL(new RegExp(`branch=${combined.id}`));
    await page.reload();
    await expect(page.locator(`[data-message-id="${combined.id}"]`)).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(editor).toHaveValue('保留未发送草稿');
    const next = await page.request
      .post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: combined.id, content: '下一个问题' },
      })
      .then((r) => r.json());
    const nextRun = await page.request
      .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId: next.runId } })
      .then((r) => r.json());
    expect(
      nextRun.context.map(({ role, content }: { role: string; content: string }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: 'user', content: '请回答原问题' },
      { role: 'assistant', content: messageText(combined) },
      { role: 'user', content: '下一个问题' },
    ]);
    await expect
      .poll(async () => (await snapshot()).messages.find((m) => m.id === next.assistantId)?.status)
      .toBe('completed');
    expect(
      (
        await page.request.delete(`/api/conversations/${id}/messages/${source.id}`, { headers })
      ).ok(),
    ).toBe(true);
    expect(messageText((await snapshot()).messages.find((m) => m.id === combined.id))).toBe(
      messageText(combined),
    );
    const portable = await page.request
      .get(`/api/conversations/${id}/backup`)
      .then((r) => r.json());
    const saved = portable.conversation.messages.find((m: { id: string }) => m.id === combined.id);
    expect(messageText(saved)).toBe(messageText(combined));
    const sourceReceipt = saved.inputEvidence.steps[0].items.find(
      (entry: { item: { sourceId: string } }) => entry.item.sourceId === source.id,
    );
    expect(sourceReceipt.item.content).toBe('snapshot');
    expect(sourceReceipt.snapshot).toBe(messageText(source));
    const copiedResponse = await page.request.post(
      `/api/conversations/${id}/messages/${combined.id}/duplicate`,
      { headers, data: { requestId: crypto.randomUUID() } },
    );
    expect(copiedResponse.status()).toBe(201);
    const copied = await copiedResponse.json();
    copyId = copied.id;
    const copiedAnswer = copied.snapshot.messages.find(
      (m: { continuation?: unknown }) => m.continuation,
    );
    expect(messageText(copiedAnswer)).toBe(messageText(combined));
    expect(copiedAnswer.continuation.detached).toBe(true);
  } finally {
    if (copyId) await page.request.delete(`/api/conversations/${copyId}`, { headers });
    await page.request.delete(`/api/conversations/${id}`, { headers });
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});

test('interrupted sources, idempotent continuation, empty failures and cancelled partial continuations retain correct versions', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const initial = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const models = [
    'diagnostic-disconnect',
    'metadata-reasoning',
    'metadata-no-output',
    'benchmark-text-12-250-32',
  ];
  const snapshot = () =>
    request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
  const submit = async (data: Record<string, unknown>, model: string) => {
    const response = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: { ...data, selection: { providerId, model } },
    });
    expect(response.status()).toBe(202);
    return response.json();
  };
  try {
    await request.put('/api/settings/providers', {
      headers,
      data: {
        ...initial,
        activeProviderId: providerId,
        activeModel: models[0],
        providers: [
          {
            id: providerId,
            name: 'Continuation edges',
            provider: 'openai-chat',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'integration-test-key',
            models: models.map((model) => ({
              id: model,
              name: model,
              enabled: true,
              reasoningSupport: 'supported',
            })),
          },
        ],
      },
    });
    await request.post('/api/conversations', { headers, data: { id, title: '继续边界' } });
    const first = await submit(
      { requestId: crypto.randomUUID(), parentId: null, content: '原问题' },
      models[0],
    );
    await expect
      .poll(
        async () =>
          (await snapshot()).messages.find((m) => m.id === first.assistantId)?.generation
            ?.interrupted,
      )
      .toBe(true);
    const source = (await snapshot()).messages.find((m) => m.id === first.assistantId)!;
    const input = { requestId: crypto.randomUUID(), continueOf: source.id };
    const [a, duplicate] = await Promise.all([submit(input, models[1]), submit(input, models[1])]);
    expect(a).toEqual(duplicate);
    await expect
      .poll(async () => (await snapshot()).messages.find((m) => m.id === a.assistantId)?.status)
      .toBe('completed');
    const combined = (await snapshot()).messages.find((m) => m.id === a.assistantId)!;
    expect(messageText(combined)).toBe(messageText(source) + '正文后到');
    expect(combined.generation?.interrupted).toBeUndefined();
    const empty = await submit(
      { requestId: crypto.randomUUID(), continueOf: combined.id },
      models[2],
    );
    await expect
      .poll(async () => (await snapshot()).messages.find((m) => m.id === empty.assistantId)?.status)
      .toBe('failed');
    const failed = (await snapshot()).messages.find((m) => m.id === empty.assistantId)!;
    expect(messageText(failed)).toBe(messageText(combined));
    expect(localAnswerText(failed)).toBe('');
    const partial = await submit(
      { requestId: crypto.randomUUID(), continueOf: combined.id },
      models[3],
    );
    await expect
      .poll(async () => {
        const message = (await snapshot()).messages.find((m) => m.id === partial.assistantId);
        return Boolean(message && message.status === 'running' && localAnswerText(message).length);
      })
      .toBe(true);
    await request.post(`/api/conversations/${id}/cancel`, {
      headers,
      data: { runId: partial.runId },
    });
    await expect
      .poll(
        async () =>
          (await snapshot()).messages.find((m) => m.id === partial.assistantId)?.generation
            ?.interrupted,
      )
      .toBe(true);
    const retained = (await snapshot()).messages.find((m) => m.id === partial.assistantId)!;
    expect(retained.status).toBe('completed');
    expect(messageText(retained).startsWith(messageText(combined))).toBe(true);
    expect(localAnswerText(retained).length).toBeGreaterThan(0);
    expect((await snapshot()).messages.find((m) => m.id === source.id)).toEqual(source);
  } finally {
    await request.delete(`/api/conversations/${id}`, { headers });
    await request.put('/api/settings/providers', { headers, data: initial });
  }
});
