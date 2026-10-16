import { messageText } from '../../shared/conversation/content';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { LibrarySearch } from '../../shared/search/query';
import type { ProviderSettings } from '../../shared/providers/types';
import type { Snapshot } from '../../shared/streaming/protocol';
import type { Submission } from '../../shared/conversation/types';
const headers = { Origin: 'http://127.0.0.1:5174' };
const control = (request: APIRequestContext, data: { id?: string; fail?: boolean; rebuild?: boolean }) => request.post('/api/__test/library/search', { headers, data });
const search = async (request: APIRequestContext, query: string, archived = false, cursor?: string) => {
  const response = await request.get(`/api/search?${new URLSearchParams({ q: query, archived: String(archived), ...(cursor ? { cursor } : {}) })}`);
  expect(response.status()).toBe(200); return response.json() as Promise<LibrarySearch>;
};
async function seed(request: APIRequestContext, count = 1) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '跨对话测试' } })).status()).toBe(201);
  expect((await request.post(`/api/__test/conversations/${id}/indexed-history`, { headers, data: { count } })).ok()).toBe(true);
  expect((await control(request, { id, rebuild: true })).ok()).toBe(true);
  await expect.poll(async () => (await control(request, { id }).then((r) => r.json())).progress?.done).toBe(1);
  return id;
}

test('cross-conversation search uses paginated literal text and jumps to the matching body or thoughts', async ({ page }) => {
  const id = await seed(page.request, 47);
  try {
    const ids: string[] = []; let cursor: string | undefined;
    do { const result = await search(page.request, '全文TOKEN', false, cursor); expect(result.results.length).toBeLessThanOrEqual(20); ids.push(...result.results.map((item) => item.messageId)); cursor = result.cursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(47); expect(new Set(ids).size).toBe(47);
    for (const query of ['跨越 格式 搜索', '中', 'Åbc', '*', '[a+b]', '😀']) expect((await search(page.request, query)).results.length, query).toBeGreaterThan(0);
    await page.goto('/');
    await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('全文TOKEN');
    const results = page.getByRole('region', { name: '正文搜索结果' });
    await expect(results.getByRole('link')).toHaveCount(20);
    await results.getByRole('button', { name: '加载更多结果' }).click(); await expect(results.getByRole('link')).toHaveCount(40);
    await results.getByRole('button', { name: '加载更多结果' }).click(); await expect(results.getByRole('link')).toHaveCount(47);
    await results.getByRole('link').first().click(); await expect(page).toHaveURL((url) => url.pathname === `/c/${id}`);
    await expect(page.locator('[data-search-current]')).toHaveAttribute('data-message-id', ids[0]);
    // Markdown can replace text nodes after the target article has been found.
    await expect.poll(() => page.evaluate(() => String(CSS.highlights.get('everchat-search')?.values().next().value ?? ''))).toBe('全文TOKEN');
    await page.getByRole('button', { name: '关闭对话搜索' }).click();
    await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('独立思考 46');
    await expect(results.getByRole('link')).toHaveCount(1); await results.getByRole('link').click();
    await expect(page.locator('[data-search-current] [data-testid="message-reasoning"]')).toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => String(CSS.highlights.get('everchat-search')?.values().next().value ?? ''))).toBe('独立思考 46');
  } finally { await page.request.delete(`/api/conversations/${id}`, { headers }); }
});

test('search excludes archived and deleted conversations and invalidates an old cursor after updates', async ({ request }) => {
  const id = await seed(request, 24);
  try {
    const first = await search(request, '全文TOKEN'); expect(first.cursor).toBeTruthy();
    expect((await request.patch(`/api/conversations/${id}`, { headers, data: { archived: true, title: '归档新标题' } })).ok()).toBe(true);
    expect((await search(request, '全文TOKEN')).results).toHaveLength(0);
    expect((await search(request, '全文TOKEN', true)).results[0].title).toBe('归档新标题');
    expect((await request.get(`/api/search?${new URLSearchParams({ q: '全文TOKEN', cursor: first.cursor! })}`)).status()).toBe(409);
    await request.post(`/api/__test/conversations/${id}/delete-failure`, { headers, data: {} });
    expect((await request.delete(`/api/conversations/${id}`, { headers })).status()).toBe(500);
    expect((await search(request, '全文TOKEN', true)).results).toHaveLength(0);
    await expect.poll(async () => (await control(request, { id }).then((r) => r.json())).versions.length).toBe(0);
  } finally { await request.delete(`/api/conversations/${id}`, { headers }); }
});

test('mobile search closes the sidebar for navigation, shows offline status and debounces rapid typing', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const id = await seed(page.request, 1);
  try {
    await page.goto('/'); await page.getByRole('button', { name: '打开对话列表' }).click();
    let calls = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/search') calls++; });
    const input = page.getByRole('textbox', { name: '搜索对话', exact: true });
    await input.pressSequentially('全文TOKEN', { delay: 15 });
    const results = page.getByRole('region', { name: '正文搜索结果' });
    await expect(results.getByRole('link')).toHaveCount(1); expect(calls).toBe(1);
    await results.getByRole('link').click(); await expect(page).toHaveURL((url) => url.pathname === `/c/${id}`);
    await expect(page.getByRole('textbox', { name: '查找当前对话', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: '关闭对话列表', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '打开对话列表' }).click();
    await context.setOffline(true); await input.fill('未缓存关键词');
    await expect(results).toContainText('联网后搜索正文'); await expect(results.getByRole('link')).toHaveCount(0);
    expect(calls).toBe(1);
    await context.setOffline(false); await input.fill('独立思考'); await expect(results.getByRole('link')).toHaveCount(1);
  } finally { await context.setOffline(false); await page.request.delete(`/api/conversations/${id}`, { headers }); }
});

test('durable search outbox survives an RPC failure and object reset without another supplier request', async ({ request }) => {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const settings = await request.get('/api/settings/providers').then((r) => r.json()) as ProviderSettings;
  const id = crypto.randomUUID(), providerId = crypto.randomUUID();
  try {
    await request.put('/api/settings/providers', { headers, data: { providers: [{ id: providerId, name: 'Index fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [{ id: 'alarm-stall', name: 'Index fixture', enabled: true }] }], activeProviderId: providerId, activeModel: 'alarm-stall', showReasoning: true, systemPrompt: '', maxOutputTokens: null } });
    await request.post('/api/conversations', { headers, data: { id, title: '索引重试' } });
    await control(request, { fail: true });
    const response = await request.post(`/api/conversations/${id}/messages`, { headers, data: { parentId: null, requestId: crypto.randomUUID(), content: '索引提问TOKEN', showReasoning: true } });
    expect(response.status()).toBe(202); const submission = await response.json() as Submission;
    await expect.poll(async () => messageText((await request.get(`/api/conversations/${id}`).then((r) => r.json()) as Snapshot).messages.at(-1))).toContain('等待上游的正文');
    await request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId: submission.runId } });
    const state = () => request.post(`/api/__test/conversations/${id}/search-state`, { headers, data: {} }).then((r) => r.json());
    await expect.poll(async () => (await state()).pending.length).toBe(2);
    const retry = (await state()).retry;
    expect(retry.attempts).toBeGreaterThan(0); expect(retry.nextAt).toBeGreaterThan(Date.now() + 20_000);
    expect((await search(request, '索引提问TOKEN')).results).toHaveLength(0);
    await request.post(`/api/__test/conversations/${id}/search-reset`, { headers, data: {} });
    expect((await state()).pending).toHaveLength(2);
    expect((await state()).retry).toEqual(retry);
    await control(request, { fail: false });
    await request.post(`/api/__test/conversations/${id}/search-retry`, { headers, data: {} });
    await expect.poll(async () => (await state()).pending.length).toBe(0);
    expect((await search(request, '索引提问TOKEN')).results[0].messageId).toBe(submission.userId);
    expect((await search(request, '等待上游的正文')).results[0].messageId).toBe(submission.assistantId);
    expect((await search(request, '等待上游的思考')).results[0].field).toBe('reasoning');
    const run = await request.post(`/api/__test/conversations/${id}/state`, { headers, data: { runId: submission.runId } }).then((r) => r.json());
    expect(run.calls).toBe(1);
    const versions = (await control(request, { id }).then((r) => r.json())).versions;
    await request.post(`/api/__test/conversations/${id}/alarm`, { headers, data: {} });
    expect((await control(request, { id }).then((r) => r.json())).versions).toEqual(versions);
  } finally {
    await control(request, { fail: false }); await request.delete(`/api/conversations/${id}`, { headers });
    await request.put('/api/settings/providers', { headers, data: settings });
  }
});
