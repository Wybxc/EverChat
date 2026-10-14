import { messageParts, messageText } from '../../shared/message-content';
import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import type { ProviderSettings, Snapshot, Submission, SyncPacket } from '../../shared/types';
import type { EverChatBackup } from '../../shared/backup';

const origin = 'http://127.0.0.1:5174', headers = { Origin: origin };
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const settings = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID(), id = crypto.randomUUID();
  expect((await request.put('/api/settings/providers', { headers, data: {
    providers: [{ id: providerId, name: 'Mutation fixture', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
      models: [{ id: 'benchmark-reasoning-2-10-32', name: 'Mutation fixture', enabled: true, reasoningSupport: 'supported' }] }],
    activeProviderId: providerId, activeModel: 'benchmark-reasoning-2-10-32', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
  } })).ok()).toBe(true);
  expect((await request.post('/api/conversations', { headers, data: { id, title: '消息修订验证' } })).status()).toBe(201);
  const snapshot = () => request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>;
  const send = async (content: string, branchHead?: string) => {
    const response = await request.post(`/api/conversations/${id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content, branchHead, showReasoning: true } });
    expect(response.status()).toBe(202);
    return await response.json() as Submission;
  };
  const done = () => expect.poll(async () => (await snapshot()).messages.at(-1)?.status).toBe('completed');
  return { id, snapshot, send, done, cleanup: async (extra: string[] = []) => {
    for (const conversation of [id, ...extra]) await request.delete(`/api/conversations/${conversation}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: settings })).ok()).toBe(true);
  } };
}

async function replay(request: APIRequestContext, id: string) {
  const { cookies } = await request.storageState();
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`, { headers: { ...headers, Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') } });
  const packets: SyncPacket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Replay timeout')), 10_000);
      socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.on('message', (data) => {
        const packet = JSON.parse(data.toString()) as SyncPacket;
        packets.push(packet);
        if (packet.type === 'ready') { clearTimeout(timeout); resolve(); }
      });
    });
    return packets;
  } finally { socket.terminate(); }
}

test('assistant revisions are idempotent and message deletion redacts context, replay, search and backups', async ({ request }) => {
  const fixture = await setup(request), copies: string[] = [];
  const prompt = `INPUT-${fixture.id}`, editedText = `MANUAL-${fixture.id}\n${'正文🙂'.repeat(10000)}`;
  try {
    await fixture.send(prompt); await fixture.done();
    const before = await fixture.snapshot(), original = before.messages[1];
    const input = { requestId: crypto.randomUUID(), content: editedText };
    const edit = () => request.patch(`/api/conversations/${fixture.id}/messages/${original.id}`, { headers, data: input });
    const first = await edit(), duplicate = await edit();
    expect(first.status()).toBe(201); expect(duplicate.status()).toBe(201);
    const revised = await first.json() as { messageId: string };
    expect(await duplicate.json()).toEqual(revised);
    expect((await request.patch(`/api/conversations/${fixture.id}/messages/${original.id}`, { headers, data: { ...input, content: 'different' } })).status()).toBe(409);
    const saved = await fixture.snapshot();
    expect(saved.messages).toHaveLength(3); expect(saved.messages[1]).toEqual(original);
    expect(saved.messages[2]).toMatchObject({ id: revised.messageId, parentId: before.messages[0].id, revisionOf: original.id, runId: null, parts: messageParts(editedText, '') });
    expect(saved.messages[2].generation).toBeUndefined();
    await expect.poll(async () => (await request.get(`/api/search?q=${encodeURIComponent(`MANUAL-${fixture.id}`)}`).then((response) => response.json())).results.length).toBe(1);

    const continued = await fixture.send('保留的后续问题', revised.messageId);
    const context = await request.post(`/api/__test/conversations/${fixture.id}/context`, { headers, data: { runId: continued.runId } }).then((response) => response.json());
    expect(context.context.map(({ content }: { content: string }) => content)).toEqual([prompt, editedText, '保留的后续问题']);
    await fixture.done();
    const endpoint = `/api/conversations/${fixture.id}/messages/${revised.messageId}`;
    const deleted = await request.delete(endpoint, { headers }); expect(deleted.status()).toBe(200);
    expect(await request.delete(endpoint, { headers }).then((response) => response.json())).toEqual(await deleted.json());
    expect((await edit()).status()).toBe(409);
    expect((await request.delete(`/api/conversations/${fixture.id}/messages/${before.messages[0].id}`, { headers })).status()).toBe(200);
    const tombstones = await fixture.snapshot();
    expect(tombstones.messages[2]).toMatchObject({ parentId: before.messages[0].id, parts: [] });
    expect(tombstones.messages[2].deletedAt).toBeGreaterThan(0);
    expect(messageText(tombstones.messages[0])).toBe('');
    expect((await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), retryOf: original.id } })).status()).toBe(404);
    expect((await request.post(`/api/conversations/${fixture.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), content: 'invalid head', branchHead: revised.messageId } })).status()).toBe(404);
    const next = await fixture.send('删除后继续', continued.assistantId);
    const nextContext = await request.post(`/api/__test/conversations/${fixture.id}/context`, { headers, data: { runId: next.runId } }).then((response) => response.json());
    expect(nextContext.context.map(({ role }: { role: string }) => role)).toEqual(['user', 'assistant', 'user']);
    expect(nextContext.context[0].content).toBe('保留的后续问题');
    expect(JSON.stringify(nextContext)).not.toContain(prompt); expect(JSON.stringify(nextContext)).not.toContain(`MANUAL-${fixture.id}`);
    await fixture.done();
    await expect.poll(async () => (await request.get(`/api/search?q=${encodeURIComponent(`MANUAL-${fixture.id}`)}`).then((response) => response.json())).results.length).toBe(0);
    const packets = await replay(request, fixture.id);
    expect(packets[0].type).toBe('snapshot');
    expect(JSON.stringify(packets)).not.toContain(prompt); expect(JSON.stringify(packets)).not.toContain(`MANUAL-${fixture.id}`);
    const backup = await request.get(`/api/conversations/${fixture.id}/backup`).then((response) => response.json()) as EverChatBackup;
    expect(JSON.stringify(backup)).not.toContain(prompt); expect(JSON.stringify(backup)).not.toContain(`MANUAL-${fixture.id}`);
    const restoredResponse = await request.post('/api/backup/restore', { headers, data: backup }); expect(restoredResponse.status()).toBe(201);
    const restored = await restoredResponse.json() as { id: string; snapshot: Snapshot }; copies.push(restored.id);
    expect(restored.snapshot.messages.filter(({ deletedAt }) => deletedAt)).toHaveLength(2);
    expect(restored.snapshot.messages[3].parentId).toBe(restored.snapshot.messages[2].id);
  } finally { await fixture.cleanup(copies); }
});

test('message mutations require authentication and reject generation races or invalid edits', async ({ request }) => {
  const unknown = `/api/conversations/${crypto.randomUUID()}/messages/${crypto.randomUUID()}`;
  expect((await request.patch(unknown, { headers, data: { requestId: crypto.randomUUID(), content: 'text' } })).status()).toBe(401);
  expect((await request.delete(unknown, { headers })).status()).toBe(401);
  const fixture = await setup(request);
  try {
    const first = await fixture.send('第一条'); await fixture.done();
    const endpoint = `/api/conversations/${fixture.id}/messages/${first.assistantId}`;
    expect((await request.patch(endpoint, { data: { requestId: crypto.randomUUID(), content: 'text' } })).status()).toBe(403);
    expect((await request.delete(endpoint)).status()).toBe(403);
    expect((await request.patch(endpoint, { headers, data: { requestId: crypto.randomUUID(), content: ' ' } })).status()).toBe(400);
    expect((await request.patch(endpoint, { headers, data: { requestId: crypto.randomUUID(), content: 'a'.repeat(100001) } })).status()).toBe(400);
    const second = await fixture.send('排队中的问题');
    expect((await request.patch(endpoint, { headers, data: { requestId: crypto.randomUUID(), content: 'racing edit' } })).status()).toBe(409);
    expect((await request.delete(endpoint, { headers })).status()).toBe(409);
    await request.post(`/api/conversations/${fixture.id}/cancel`, { headers, data: { runId: second.runId } });
  } finally { await fixture.cleanup(); }
});

test('editing and deleting an answer preserves drafts, syncs another device and restores focus', async ({ page, browser }) => {
  const fixture = await setup(page.request);
  const second = await browser.newContext();
  try {
    await fixture.send('界面测试'); await fixture.done();
    await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    const other = await second.newPage(); await other.goto(`/c/${fixture.id}`);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(`/c/${fixture.id}`);
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('保留草稿');
    await page.getByRole('button', { name: '编辑回答', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑回答', exact: true });
    await expect(editor.getByLabel('回答内容')).toBeFocused();
    await expect(editor.getByRole('button', { name: '关闭消息操作' })).toBeInViewport();
    await expect(editor.getByRole('button', { name: '保存新版本' })).toBeInViewport();
    await editor.getByLabel('回答内容').fill('手动修改后的回答');
    await page.route('**/api/conversations/*/messages/*', async (route) => {
      if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法保存' }) });
      else await route.continue();
    });
    await editor.getByRole('button', { name: '保存新版本' }).click();
    await expect(editor.getByRole('alert')).toContainText('暂时无法保存');
    await expect(editor.getByLabel('回答内容')).toHaveValue('手动修改后的回答');
    await page.unroute('**/api/conversations/*/messages/*');
    await editor.getByRole('button', { name: '保存新版本' }).click();
    await expect(editor).not.toBeVisible();
    await expect(composer).toHaveValue('保留草稿'); await expect(composer).toBeFocused();
    await expect(page.getByTestId('assistant-message').last()).toContainText('手动修改后的回答');
    await expect(other.getByTestId('assistant-message').last()).toContainText('手动修改后的回答');
    const revised = page.getByTestId('assistant-message').last();
    await revised.getByRole('button', { name: '删除消息', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除消息', exact: true });
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await expect(revised.getByRole('button', { name: '删除消息', exact: true })).toBeFocused();
    await revised.getByRole('button', { name: '删除消息', exact: true }).click();
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(revised).toHaveText('消息已删除');
    await expect(other.getByTestId('assistant-message').last()).toHaveText('消息已删除');
    await expect(composer).toHaveValue('保留草稿'); await expect(composer).toBeFocused();
    await page.reload(); await expect(page.getByTestId('assistant-message').last()).toHaveText('消息已删除');
  } finally { await second.close(); await fixture.cleanup(); }
});
