import { test, expect, type APIRequestContext } from '@playwright/test';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };

async function configure(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json());
  const providerId = '00000000-0000-4000-8000-000000000099';
  const settings = {
    providers: [{ id: providerId, name: 'Integration', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', models: [{ id: 'test-model', name: 'test-model', enabled: true }], apiKey: 'integration-test-key' }],
    activeProviderId: providerId, activeModel: 'test-model', systemPrompt: '', maxOutputTokens: 128, showReasoning: false,
  };
  expect((await request.put('/api/settings/providers', { headers, data: settings })).status()).toBe(200);
  return { initial };
}

test('continuing an older branch keeps alternate answers out of the provider context', async ({ request }) => {
  const { initial } = await configure(request);
  const id = crypto.randomUUID();
  try {
    expect((await request.post('/api/conversations', { headers, data: { id, title: '分支上下文' } })).status()).toBe(201);
    const first = await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '第一条消息' } });
    expect(first.status()).toBe(202);
    await expect.poll(async () => (await request.get(`/api/conversations/${id}`).then((response) => response.json())).messages.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
    const firstSnapshot = await request.get(`/api/conversations/${id}`).then((response) => response.json());
    const firstAssistant = firstSnapshot.messages[1];

    const retry = await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), retryOf: firstAssistant.id, branchHead: firstAssistant.id } });
    expect(retry.status()).toBe(202);
    await expect.poll(async () => (await request.get(`/api/conversations/${id}`).then((response) => response.json())).messages.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
    const retried = await request.get(`/api/conversations/${id}`).then((response) => response.json());
    expect(retried.messages).toHaveLength(3);
    expect(retried.messages[2]).toMatchObject({ role: 'assistant', revisionOf: firstAssistant.id, parentId: retried.messages[0].id });

    const branch = await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '沿旧分支继续', branchHead: firstAssistant.id } });
    expect(branch.status()).toBe(202);
    const branchSubmission = await branch.json() as { runId: string; userId: string; assistantId: string };
    const context = await request.post(`/api/__test/conversations/${id}/context`, { headers, data: { runId: branchSubmission.runId } }).then((response) => response.json());
    expect(context.context).toHaveLength(3);
    expect(context.context.map(({ role }: { role: string }) => role)).toEqual(['user', 'assistant', 'user']);
    expect(context.context[0].content).toBe('第一条消息');
    expect(context.context[2].content).toBe('沿旧分支继续');
    await expect.poll(async () => (await request.get(`/api/conversations/${id}`).then((response) => response.json())).messages.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
    const final = await request.get(`/api/conversations/${id}`).then((response) => response.json());
    expect(final.messages[3]).toMatchObject({ role: 'user', parentId: firstAssistant.id });
    expect(final.messages[4]).toMatchObject({ role: 'assistant', parentId: final.messages[3].id });
  } finally {
    await request.delete(`/api/conversations/${id}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: initial })).status()).toBe(200);
  }
});
