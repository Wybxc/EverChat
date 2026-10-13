import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ProviderSettings, Snapshot } from '../../shared/types';
import { MAX_CONVERSATIONS, MAX_DATABASE_BYTES, MAX_DATABASE_START_BYTES, MAX_DATABASE_WRITE_BYTES, STORAGE_QUOTA_MESSAGE } from '../../worker/resource-limits';
const headers = { Origin: 'http://127.0.0.1:5174' };
const action = (request: APIRequestContext, id: string, name: string, data: unknown = {}) => request.post(`/api/__test/conversations/${id}/${name}`, { headers, data });
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const original = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID();
  expect((await request.put('/api/settings/providers', { headers, data: {
    providers: [{ id: providerId, name: 'Capacity fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
      models: [{ id: 'alarm-test', name: 'Capacity fixture', enabled: true, reasoningSupport: 'supported' }] }],
    activeProviderId: providerId, activeModel: 'alarm-test', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
  } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: 'Capacity test' } })).status()).toBe(201);
  return { id, restore: async () => { expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(true); } };
}

test('history capacity rejects generation before writing messages or calling the supplier, without hiding existing history', async ({ request }) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'history', { pairs: 16 })).ok()).toBe(true);
    const before = await request.get(`/api/conversations/${fixture.id}`).then((response) => response.json()) as Snapshot;
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '不能接受的输入' } });
    expect(response.status()).toBe(507); expect((await response.json()).error).toContain('历史容量');
    expect(await action(request, fixture.id, 'resources').then((response) => response.json())).toMatchObject({ messages: 32, runs: 0, calls: 0 });
    expect(await request.get(`/api/conversations/${fixture.id}`).then((response) => response.json())).toEqual(before);
  } finally { await fixture.restore(); }
});

test('database allocation reserves space for generation and blocks before accepting an input', async ({ request }) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'fill', { target: MAX_DATABASE_START_BYTES + 4096 })).ok()).toBe(true);
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: '容量不足' } });
    expect(response.status()).toBe(507); expect((await response.json()).error).toContain('存储容量');
    expect(await action(request, fixture.id, 'resources').then((response) => response.json())).toMatchObject({ messages: 0, runs: 0, calls: 0 });
  } finally { await fixture.restore(); }
});

test('capacity reached during generation terminates without retrying, retains the durable prefix and releases stored context', async ({ request }) => {
  const fixture = await setup(request);
  try {
    const input = { requestId: crypto.randomUUID(), content: '开始后模拟空间不足', showReasoning: true };
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: input });
    expect(response.status()).toBe(202); const accepted = await response.json();
    const snapshot = () => request.get(`/api/conversations/${fixture.id}`).then((result) => result.json()) as Promise<Snapshot>;
    await expect.poll(async () => (await snapshot()).messages[1].content.length).toBeGreaterThan(0);
    const prefix = (await snapshot()).messages[1].content;
    expect((await action(request, fixture.id, 'fill', { target: MAX_DATABASE_WRITE_BYTES + 4096 })).ok()).toBe(true);
    await expect.poll(async () => (await snapshot()).messages[1].status).toBe('failed');
    const stored = await snapshot();
    expect(stored.messages[1].content.startsWith(prefix)).toBe(true);
    expect(stored.messages[1].content).not.toContain('服务端生成完成');
    expect(stored.messages[1].error).toContain('存储容量');
    const resources = await action(request, fixture.id, 'resources').then((result) => result.json());
    expect(resources).toMatchObject({ calls: 1, runs: 1, retainedContexts: 0, journalRows: 0 });
    expect(resources.databaseBytes).toBeLessThanOrEqual(MAX_DATABASE_BYTES);
    const repeated = await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: input });
    expect(repeated.status()).toBe(202); expect(await repeated.json()).toEqual(accepted);
    expect((await action(request, fixture.id, 'alarm')).ok()).toBe(true);
    expect(await snapshot()).toEqual(stored);
    expect((await action(request, fixture.id, 'resources').then((result) => result.json())).calls).toBe(1);
  } finally { await fixture.restore(); }
});

test('Library serializes concurrent creations at the limit and allows idempotent retries when full', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const capacity = (seed: boolean) => request.post('/api/__test/library/capacity', { headers, data: { seed } });
  try {
    expect(await capacity(true).then((response) => response.json())).toEqual({ count: MAX_CONVERSATIONS - 1 });
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    const responses = await Promise.all(ids.map((id) => request.post('/api/conversations', { headers, data: { id, title: '__capacity_fixture__' } })));
    expect(responses.filter((response) => response.status() === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status() === 507)).toHaveLength(11);
    const index = responses.findIndex((response) => response.status() === 201);
    const repeated = await request.post('/api/conversations', { headers, data: { id: ids[index], title: '__capacity_fixture__' } });
    expect(repeated.status()).toBe(201); expect((await repeated.json()).id).toBe(ids[index]);
    expect(await request.get('/api/conversations').then((response) => response.json()).then((items) => items.length)).toBe(MAX_CONVERSATIONS);
  } finally { expect((await capacity(false)).ok()).toBe(true); }
});

test('a native storage error crosses RPC as a sanitized 507 response', async ({ request }) => {
  const fixture = await setup(request);
  try {
    expect((await action(request, fixture.id, 'storage-error')).ok()).toBe(true);
    const response = await request.get(`/api/conversations/${fixture.id}`);
    expect(response.status()).toBe(507); expect(await response.json()).toEqual({ error: STORAGE_QUOTA_MESSAGE });
  } finally { await fixture.restore(); }
});

test('a storage sync error is visible, pauses automatic retries and supports manual recovery', async ({ page }) => {
  const fixture = await setup(page.request);
  let failing = true, reads = 0;
  await page.route(`**/api/conversations/${fixture.id}`, async (route) => {
    reads++;
    if (failing) await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: STORAGE_QUOTA_MESSAGE }) });
    else await route.continue();
  });
  try {
    await page.goto('/');
    await page.locator('aside').getByRole('link', { name: 'Capacity test', exact: true }).first().click();
    await expect(page.getByRole('alert')).toContainText(STORAGE_QUOTA_MESSAGE);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留草稿');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    const stopped = reads; await page.waitForTimeout(2000); expect(reads).toBe(stopped);
    failing = false; await page.getByRole('button', { name: '重新同步', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留草稿');
  } finally { await fixture.restore(); }
});
