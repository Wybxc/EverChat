import { messageMenu } from '../ui';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ConversationInfo, ConversationSettings, Message, Submission } from '../../shared/conversation/types';
import type { ProviderSettings } from '../../shared/providers/types';
import type { Snapshot } from '../../shared/streaming/protocol';
import { branchPath } from '../../shared/conversation/branch-path';
import { isActive } from '../../shared/conversation/message-state';
import { messageText } from '../../shared/conversation/content';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '复制源对话' } })).status()).toBe(201);
  expect((await request.post(`/api/__test/conversations/${id}/search-history`, { headers, data: {} })).ok()).toBe(true);
  return { id, cleanup: async (copy?: string) => { await request.delete(`/api/conversations/${id}`, { headers }); if (copy) await request.delete(`/api/conversations/${copy}`, { headers }); } };
}

test('copying a conversation creates a new URL with the same messages and independent IDs', async ({ page }) => {
  const source = await setup(page.request);
  const copyIds: string[] = [];
  try {
    const original = await page.request.get(`/api/conversations/${source.id}`).then((response) => response.json()) as Snapshot;
    const copied = await page.request.post(`/api/conversations/${source.id}/duplicate`, { headers, data: { requestId: crypto.randomUUID() } });
    expect(copied.status()).toBe(201);
    const result = await copied.json() as { id: string; snapshot: Snapshot; conversation: { title: string } };
    copyIds.push(result.id);
    expect(result.id).not.toBe(source.id);
    expect(result.conversation.title).toBe('复制源对话 副本');
    expect(result.snapshot.messages.map(({ parts, modelName }) => ({ parts, modelName }))).toEqual(
      original.messages.map(({ parts, modelName }) => ({ parts, modelName })),
    );
    expect(result.snapshot.messages.map(({ id }) => id)).not.toEqual(original.messages.map(({ id }) => id));

    await page.goto(`/c/${source.id}`);
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制对话', exact: true }).click();
    await expect(page).not.toHaveURL((url) => url.pathname === `/c/${source.id}`);
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}(?:\?branch=[^#]+)?$/);
    const uiCopyId = new URL(page.url()).pathname.split('/').at(-1)!;
    copyIds.push(uiCopyId);
    expect(uiCopyId).not.toBe(source.id);
    await expect(page.getByRole('banner').getByText('复制源对话 副本', { exact: true })).toBeVisible();
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  } finally { await page.request.delete(`/api/conversations/${source.id}`, { headers }); for (const id of copyIds) await page.request.delete(`/api/conversations/${id}`, { headers }); }
});

async function generationSource(request: APIRequestContext, model = 'metadata-copy') {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const id = crypto.randomUUID(), providerId = crypto.randomUUID();
  expect((await request.put('/api/settings/providers', { headers, data: {
    providers: [{ id: providerId, name: 'Copy fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
      models: [{ id: model, name: 'Copy model', enabled: true, reasoningSupport: 'supported' },
        { id: 'benchmark-text-2-10-32', name: 'Plain copy model', enabled: true, reasoningSupport: 'unsupported' }] }],
    activeProviderId: providerId, activeModel: model, systemPrompt: 'Global prompt', maxOutputTokens: null, showReasoning: true,
  } })).ok()).toBe(true);
  expect((await request.post('/api/conversations', { headers, data: { id, title: '选定消息复制' } })).status()).toBe(201);
  const settings: ConversationSettings = { systemPrompt: 'Conversation prompt', temperature: 0.6, topP: 0.8, useGlobalMaxOutputTokens: false, maxOutputTokens: 42, recentMessages: null, contextBudget: null, useSummaries: true, tools: [], autoCompression: { enabled: false, threshold: 80, model: null } };
  expect((await request.put(`/api/conversations/${id}/settings`, { headers, data: settings })).ok()).toBe(true);
  const snapshot = () => request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>;
  const send = async (content: string, extra: { parentId?: string | null; revisionOf?: string } = {}) => {
    const parentId = [...(await snapshot()).messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)?.id ?? null;
    const response = await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content, showReasoning: true, ...(!extra.revisionOf ? { parentId } : {}), ...extra } });
    expect(response.status()).toBe(202);
    return await response.json() as Submission;
  };
  const done = () => expect.poll(async () => (await snapshot()).messages.at(-1)?.status).toBe('completed');
  return { id, providerId, settings, snapshot, send, done, cleanup: async (copies: string[]) => {
    for (const conversationId of [id, ...copies]) await request.delete(`/api/conversations/${conversationId}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(true);
  } };
}

type Copy = { id: string; snapshot: Snapshot };
async function copyAt(request: APIRequestContext, sourceId: string, messageId: string, copies: string[]) {
  const response = await request.post(`/api/conversations/${sourceId}/messages/${messageId}/duplicate`, { headers, data: { requestId: crypto.randomUUID() } });
  expect(response.status()).toBe(201);
  const copy = await response.json() as Copy; copies.push(copy.id); return copy;
}
function expectPathCopy(copy: Snapshot, path: Message[], settings: ConversationSettings) {
  expect(copy.settings).toEqual(settings);
  expect(copy.messages).toHaveLength(path.length);
  const ids = new Map(path.map((message, index) => [message.id, copy.messages[index].id]));
  for (const [index, original] of path.entries()) {
    const message = copy.messages[index];
    expect(message.id).not.toBe(original.id);
    expect(message.runId).toBeNull();
    expect(message.parentId).toBe(original.parentId ? ids.get(original.parentId) ?? null : null);
    expect(message.revisionOf).toBe(original.revisionOf ? ids.get(original.revisionOf) ?? null : null);
    expect(message).toMatchObject({ role: original.role, parts: original.parts, createdAt: original.createdAt, status: original.status });
    expect(message.generation).toEqual(original.generation);
    expect(message.modelName ?? null).toBe(original.modelName ?? null);
    expect(message.model ?? null).toBe(original.model ?? null);
  }
}

test('copying an older answer copies only its parent path, retains settings and metadata, and continues independently', async ({ request }) => {
  const fixture = await generationSource(request), copies: string[] = [];
  try {
    const first = await fixture.send('原始问题'); await fixture.done();
    const revision = await request.patch(`/api/conversations/${fixture.id}/messages/${first.assistantId}`, { headers, data: { requestId: crypto.randomUUID(), content: '备用回答' } });
    expect(revision.status()).toBe(201); const revised = await revision.json() as { messageId: string };
    const second = await fixture.send('沿原回答的后续问题', { parentId: first.assistantId }); await fixture.done();
    await fixture.send('修改后的根问题', { revisionOf: first.userId }); await fixture.done();
    const original = await fixture.snapshot();
    expect(original.messages).toHaveLength(7);
    const path = branchPath(original.messages, second.assistantId);
    const copy = await copyAt(request, fixture.id, second.assistantId, copies);
    expectPathCopy(copy.snapshot, path, fixture.settings);
    expect(copy.snapshot.messages).toHaveLength(4);
    expect(messageText(copy.snapshot.messages[1], 'reasoning')).toBe('思考先到');
    expect(copy.snapshot.messages[1].generation?.usage.totalTokens).toBe(15);
    expect(JSON.stringify(copy.snapshot)).not.toContain('备用回答');
    expect(JSON.stringify(copy.snapshot)).not.toContain('修改后的根问题');

    const alternate = await copyAt(request, fixture.id, revised.messageId, copies);
    expectPathCopy(alternate.snapshot, branchPath(original.messages, revised.messageId), fixture.settings);
    expect(alternate.snapshot.messages[1].revisionOf).toBeNull();
    const rootRevision = await copyAt(request, fixture.id, original.messages.at(-1)!.id, copies);
    expect(rootRevision.snapshot.messages).toHaveLength(2);
    expect(rootRevision.snapshot.messages[0].revisionOf).toBeNull();

    const next = await request.post(`/api/conversations/${copy.id}/messages`, { headers, data: { parentId: copy.snapshot.messages.at(-1)!.id,
      requestId: crypto.randomUUID(), content: '在副本中继续', selection: { providerId: fixture.providerId, model: 'benchmark-text-2-10-32' },
    } });
    expect(next.status()).toBe(202); const accepted = await next.json() as Submission;
    const context = await request.post(`/api/__test/conversations/${copy.id}/context`, { headers, data: { runId: accepted.runId } }).then((response) => response.json());
    expect(context.context).toEqual([...path.map((message) => ({ role: message.role, content: messageText(message) })), { role: 'user', content: '在副本中继续' }]);
    expect(context.config).toMatchObject({ systemPrompt: 'Conversation prompt', temperature: 0.6, topP: 0.8, maxOutputTokens: 42 });
    await expect.poll(async () => (await request.get(`/api/conversations/${copy.id}`).then((response) => response.json())).messages.at(-1)?.status).toBe('completed');
    expect(await fixture.snapshot()).toEqual(original);
  } finally { await fixture.cleanup(copies); }
});

test('user and assistant copy actions open independent URLs, preserve the source draft, and retain a copied user tail in context', async ({ page, browser }) => {
  const fixture = await generationSource(page.request), copies: string[] = [];
  const secondDevice = await browser.newContext();
  try {
    const first = await fixture.send('第一条问题'); await fixture.done();
    const second = await fixture.send('复制到这里的提问'); await fixture.done();
    const original = await fixture.snapshot();
    await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/c/${fixture.id}`);
    const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('原对话草稿');
    await messageMenu(page.locator(`[data-message-id="${second.userId}"]`));
    await page.getByRole('menuitem', { name: '复制到新对话', exact: true }).click();
    await expect(page).not.toHaveURL((url) => url.pathname === `/c/${fixture.id}`); const copyId = new URL(page.url()).pathname.split('/').at(-1)!; copies.push(copyId);
    await expect(page).toHaveURL((url) => url.pathname === `/c/${copyId}`); await expect(composer).toHaveValue(''); await expect(composer).toBeFocused();
    const copied = await page.request.get(`/api/conversations/${copyId}`).then((response) => response.json()) as Snapshot;
    expectPathCopy(copied, branchPath(original.messages, second.userId), fixture.settings); expect(copied.messages).toHaveLength(3);
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await secondDevice.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    const other = await secondDevice.newPage(); await other.goto(`/c/${copyId}`);
    await expect(other.getByTestId('user-message')).toHaveCount(2); await expect(other.getByTestId('assistant-message')).toHaveCount(1);
    await composer.fill('补充说明'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await page.request.get(`/api/conversations/${copyId}`).then((response) => response.json())).messages.length).toBe(5);
    const after = await page.request.get(`/api/conversations/${copyId}`).then((response) => response.json()) as Snapshot;
    expect(after.messages[3].parentId).toBe(copied.messages[2].id);
    const context = await page.request.post(`/api/__test/conversations/${copyId}/context`, { headers, data: { runId: after.messages[4].runId } }).then((response) => response.json());
    expect(context.context.map(({ role }: { role: string }) => role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(context.context.slice(-2)).toEqual([{ role: 'user', content: '复制到这里的提问' }, { role: 'user', content: '补充说明' }]);

    await page.goto(`/c/${fixture.id}`); await expect(composer).toHaveValue('原对话草稿');
    await messageMenu(page.locator(`[data-message-id="${first.assistantId}"]`));
    await page.getByRole('menuitem', { name: '复制到新对话', exact: true }).click();
    await expect(page).not.toHaveURL((url) => url.pathname === `/c/${fixture.id}`); const answerCopyId = new URL(page.url()).pathname.split('/').at(-1)!; copies.push(answerCopyId);
    await expect(page.getByTestId('user-message')).toHaveCount(1); await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await expect(composer).toBeFocused();
    expect(await fixture.snapshot()).toEqual(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await secondDevice.close(); await fixture.cleanup(copies); }
});

test('invalid, deleted, or broken selected paths fail before creating a conversation; deleted ancestors stay redacted', async ({ request }) => {
  const unknown = `/api/conversations/${crypto.randomUUID()}/messages/${crypto.randomUUID()}/duplicate`;
  expect((await request.post(unknown, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(401);
  const fixture = await generationSource(request), copies: string[] = [];
  try {
    const first = await fixture.send('应删除的旧问题'); await fixture.done();
    const second = await fixture.send('保留的问题'); await fixture.done();
    const endpoint = `/api/conversations/${fixture.id}/messages/${second.assistantId}/duplicate`;
    const libraryIds = async () => (await request.get('/api/conversations').then((response) => response.json())).conversations.map(({ id }: ConversationInfo) => id).sort();
    const before = await libraryIds();
    expect((await request.post(endpoint)).status()).toBe(403);
    expect((await request.post(endpoint, { headers: { Origin: 'https://other.test' } })).status()).toBe(403);
    expect((await request.post(unknown, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(404);
    for (const messageId of ['invalid', crypto.randomUUID()]) expect((await request.post(`/api/conversations/${fixture.id}/messages/${messageId}/duplicate`, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(404);
    const corrupt = (parentId: string) => request.post(`/api/__test/conversations/${fixture.id}/parent`, { headers, data: { messageId: second.assistantId, parentId } });
    expect((await corrupt(crypto.randomUUID())).ok()).toBe(true); expect((await request.post(endpoint, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(409);
    expect((await corrupt(second.assistantId)).ok()).toBe(true); expect((await request.post(endpoint, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(409);
    expect(await libraryIds()).toEqual(before);
    await corrupt(second.userId);
    expect((await request.delete(`/api/conversations/${fixture.id}/messages/${first.userId}`, { headers })).ok()).toBe(true);
    expect((await request.delete(`/api/conversations/${fixture.id}/messages/${first.assistantId}`, { headers })).ok()).toBe(true);
    expect((await request.post(`/api/conversations/${fixture.id}/messages/${first.userId}/duplicate`, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(404);
    const copy = await copyAt(request, fixture.id, second.assistantId, copies);
    expect(copy.snapshot.messages).toHaveLength(4);
    for (const message of copy.snapshot.messages.slice(0, 2)) { expect(message.deletedAt).toBeGreaterThan(0); expect(message.parts).toEqual([]); expect(message.generation).toBeUndefined(); }
    expect(copy.snapshot.messages[2].parentId).toBe(copy.snapshot.messages[1].id);
    expect(JSON.stringify(copy.snapshot)).not.toContain('应删除的旧问题');
    expect((await request.delete(`/api/conversations/${fixture.id}`, { headers })).ok()).toBe(true);
    expect((await request.post(endpoint, { headers, data: { requestId: crypto.randomUUID() } })).status()).toBe(410);
  } finally { await fixture.cleanup(copies); }
});

test('copying a streaming answer takes only its durable prefix without stopping or restarting the source task', async ({ page }) => {
  const fixture = await generationSource(page.request, 'alarm-stall'), copies: string[] = [];
  try {
    await page.goto(`/c/${fixture.id}`); const accepted = await fixture.send('后台继续的问题');
    await expect.poll(async () => (await fixture.snapshot()).messages[1]?.durableOffset ?? 0).toBeGreaterThan(0);
    const before = await fixture.snapshot(); expect(isActive(before.messages[1])).toBe(true);
    const action = page.getByRole('menuitem', { name: '复制到新对话', exact: true });
    await messageMenu(page.locator(`[data-message-id="${accepted.assistantId}"]`)); await action.click(); await expect(page).not.toHaveURL((url) => url.pathname === `/c/${fixture.id}`);
    const copyId = new URL(page.url()).pathname.split('/').at(-1)!; copies.push(copyId);
    const copy = await page.request.get(`/api/conversations/${copyId}`).then((response) => response.json()) as Snapshot;
    expect(copy.messages).toHaveLength(2); expect(copy.messages[1].parts).toEqual(before.messages[1].parts);
    expect(copy.messages[1].status).toBe('failed'); expect(copy.messages[1].runId).toBeNull(); expect(copy.messages[1].streamVersion).toBeNull();
    expect(copy.messages.some(isActive)).toBe(false);
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    expect(isActive((await fixture.snapshot()).messages[1])).toBe(true);
    const state = await page.request.post(`/api/__test/conversations/${fixture.id}/state`, { headers, data: { runId: accepted.runId } }).then((response) => response.json());
    expect(state.calls).toBe(1); expect(state.cancelRequested).toBe(0);
    const copyState = await page.request.post(`/api/__test/conversations/${copyId}/deletion-state`, { headers, data: {} }).then((response) => response.json());
    expect(copyState.runs).toBe(0); expect(copyState.submissions).toBe(0);
    const userCopy = await copyAt(page.request, fixture.id, accepted.userId!, copies);
    expect(userCopy.snapshot.messages).toHaveLength(1); expect(userCopy.snapshot.messages[0].parts).toEqual(before.messages[0].parts);
    const next = await page.request.post(`/api/conversations/${copyId}/messages`, { headers, data: { parentId: copy.messages[0].id,
      requestId: crypto.randomUUID(), content: '继续未回答的提问', selection: { providerId: fixture.providerId, model: 'benchmark-text-2-10-32' },
    } });
    expect(next.status()).toBe(202); const continued = await next.json() as Submission;
    const context = await page.request.post(`/api/__test/conversations/${copyId}/context`, { headers, data: { runId: continued.runId } }).then((response) => response.json());
    expect(context.context).toEqual([{ role: 'user', content: '后台继续的问题' }, { role: 'user', content: '继续未回答的提问' }]);
    await expect.poll(async () => (await page.request.get(`/api/conversations/${copyId}`).then((response) => response.json())).messages.at(-1)?.status).toBe('completed');
  } finally { await fixture.cleanup(copies); }
});

test('copying an answer with live unconfirmed output excludes that preview while the source continues', async ({ page }) => {
  const fixture = await generationSource(page.request, 'benchmark-reasoning-20-100-32'), copies: string[] = [];
  try {
    await page.goto(`/c/${fixture.id}`); const accepted = await fixture.send('尚未确认的预览');
    const answer = page.locator(`[data-message-id="${accepted.assistantId}"]`);
    await expect.poll(async () => Number(await answer.getAttribute('data-live-offset')), { intervals: [25] }).toBeGreaterThan(0);
    expect(Number(await answer.getAttribute('data-durable-offset'))).toBe(0);
    const before = await fixture.snapshot(); expect(before.messages[1].parts).toEqual([]); expect(before.messages[1].durableOffset).toBe(0);
    const copy = await copyAt(page.request, fixture.id, accepted.assistantId, copies);
    expect(copy.snapshot.messages[1].parts).toEqual([]); expect(copy.snapshot.messages[1].status).toBe('failed'); expect(copy.snapshot.messages[1].runId).toBeNull();
    await fixture.done(); const finished = (await fixture.snapshot()).messages[1];
    expect(messageText(finished).length).toBeGreaterThan(500); expect(messageText(finished, 'reasoning').length).toBeGreaterThan(500);
    expect((await page.request.get(`/api/conversations/${copy.id}`).then((response) => response.json())).messages[1].parts).toEqual([]);
    const state = await page.request.post(`/api/__test/conversations/${fixture.id}/state`, { headers, data: { runId: accepted.runId } }).then((response) => response.json());
    expect(state.calls).toBe(1);
  } finally { await fixture.cleanup(copies); }
});

test('copy actions handle offline and errors, block double clicks, and respect navigation while the request finishes', async ({ page }) => {
  const source = await setup(page.request), copies: string[] = [];
  let release = () => {};
  try {
    await page.goto(`/c/${source.id}`);
    const message = page.getByTestId('user-message'), action = page.getByRole('menuitem', { name: '复制到新对话', exact: true, includeHidden: true });
    const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('保留草稿');
    await messageMenu(message);
    await page.context().setOffline(true); await expect(action).toBeDisabled(); await page.context().setOffline(false); await expect(action).toBeEnabled();
    const endpoint = `**/api/conversations/${source.id}/messages/*/duplicate`;
    await page.route(endpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法复制，请重试。' }) }), { times: 1 });
    await action.click(); await expect(message.getByRole('alert')).toHaveText('暂时无法复制，请重试。');
    await expect(page).toHaveURL((url) => url.pathname === `/c/${source.id}`); await expect(composer).toHaveValue('保留草稿');
    let requests = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(endpoint, async (route) => {
      requests++; const response = await route.fetch(); copies.push((await response.json()).id);
      await gate; await route.fulfill({ response });
    });
    await messageMenu(message); await action.click();
    await messageMenu(message); await expect(action).toBeDisabled(); await action.dispatchEvent('click');
    await expect.poll(() => copies.length).toBe(1); expect(requests).toBe(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '开启新对话', exact: true }).click(); await expect(page).toHaveURL('/');
    const fulfilled = page.waitForResponse((response) => response.url().endsWith('/duplicate') && response.status() === 201);
    release(); await fulfilled;
    await expect(page.getByRole('link', { name: '复制源对话 副本', exact: true })).toBeVisible(); await expect(page).toHaveURL('/');
    await page.goto(`/c/${source.id}`); await expect(composer).toHaveValue('保留草稿');
  } finally { release(); await page.context().setOffline(false); await page.request.delete(`/api/conversations/${source.id}`, { headers }); for (const id of copies) await page.request.delete(`/api/conversations/${id}`, { headers }); }
});
