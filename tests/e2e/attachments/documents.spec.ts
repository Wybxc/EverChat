import { expect,test,type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { DocumentPart } from '../../../shared/attachments/documents';
import { attachmentUrl } from '../../../shared/attachments/files';
import { messageFiles,messageText } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { expectChatModel } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' }, providerId = '00000000-0000-4000-8000-000000000089';
const text = '预算：42 元。\n<script>window.documentExecuted = true</script>\n';
const control = (request: APIRequestContext, data: object = {}) => request.post('/api/__test/library/attachments', { headers, data }).then((response) => response.json());
async function setup(request: APIRequestContext, provider: ProviderKind = 'openai-chat', vision = false) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  await control(request, { count: 0 });
  expect((await request.put('/api/settings/providers', { headers, data: {
    providers: [{ id: providerId, name: 'Document fixture', provider, baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key', models: [
      { id: `documents-${provider}`, name: '文本模型', enabled: true, metadataOverrides: { imageInput: vision, contextWindow: 200000 } },
      ...(provider === 'openai-chat' ? [{ id: 'benchmark-summary-good', name: '摘要模型', enabled: true, metadataOverrides: { contextWindow: 200000 } }] : []),
    ] }], activeProviderId: providerId, activeModel: `documents-${provider}`, systemPrompt: '', maxOutputTokens: null,
  } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '文本文件测试' } })).status()).toBe(201);
  return { id, selection: { providerId, model: `documents-${provider}` },
    snapshot: () => request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>,
    submit: (data: object) => request.post(`/api/conversations/${id}/messages`, { headers, data }),
    cleanup: () => request.delete(`/api/conversations/${id}`, { headers }) };
}
async function upload(request: APIRequestContext, id: string, bytes = Buffer.from(text), name = 'budget.ts', mediaType = 'text/plain') {
  const input = { id: crypto.randomUUID(), name, size: bytes.length, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
  expect((await request.post(`/api/conversations/${id}/attachments`, { headers, data: input })).status()).toBe(201);
  expect((await request.put(attachmentUrl(id, input.id), { headers, data: bytes })).status()).toBe(200); return input;
}
const documentUrl = (id: string, fileId: string) => `/api/conversations/${id}/attachments/${fileId}/document`;
async function parse(request: APIRequestContext, id: string, fileId: string) {
  const response = await request.post(documentUrl(id, fileId), { headers }); expect(response.status()).toBe(200); return response.json() as Promise<DocumentPart>;
}
async function submit(fixture: Awaited<ReturnType<typeof setup>>, data: object) {
  const parentId = [...(await fixture.snapshot()).messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)?.id ?? null;
  const ordinary = !('retryOf' in data) && !('revisionOf' in data) && !('summaryThrough' in data);
  const response = await fixture.submit({ ...(ordinary ? { parentId } : {}), requestId: crypto.randomUUID(), selection: fixture.selection, ...data }); expect(response.status()).toBe(202); return response.json() as Promise<Submission>;
}
async function finish(fixture: Awaited<ReturnType<typeof setup>>, submission: Submission) {
  await expect.poll(async () => (await fixture.snapshot()).messages.find((message) => message.id === submission.assistantId)?.status).toBe('completed');
  return (await fixture.snapshot()).messages.find((message) => message.id === submission.assistantId)!;
}
for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as ProviderKind[]) {
  test(`${provider}: file-only task uses private persisted text, survives page close and previews safely on another device`, async ({ request, browser }) => {
    const fixture = await setup(request, provider), original = await upload(request, fixture.id), file = await parse(request, fixture.id, original.id);
    const first = await browser.newContext(), second = await browser.newContext();
    try {
      const before = await control(request), again = await parse(request, fixture.id, original.id), after = await control(request);
      expect(again).toEqual(file); expect(after.dailyCount).toBe(before.dailyCount); expect(after.objects).toEqual(before.objects);
      await first.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
      const page = await first.newPage(); await page.goto(`/c/${fixture.id}`);
      const input = { parentId: null, requestId: crypto.randomUUID(), content: '', fileIds: [file.attachmentId], selection: fixture.selection };
      const response = await fixture.submit(input); expect(response.status()).toBe(202); const result = await response.json() as Submission;
      expect(messageFiles((await fixture.snapshot()).messages.find((message) => message.id === result.userId)!)).toEqual([file]);
      expect(JSON.stringify(await fixture.snapshot())).not.toContain(text);
      await first.close(); expect(messageText(await finish(fixture, result))).toContain('答案。');
      expect(await (await fixture.submit(input)).json()).toEqual(result); expect((await fixture.snapshot()).messages).toHaveLength(2);
      await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
      const other = await second.newPage(); await other.goto(`/c/${fixture.id}`);
      await other.getByRole('button', { name: `预览 ${file.name}` }).click();
      await expect(other.getByRole('dialog').locator('pre')).toHaveText(text.trim());
      expect(await other.evaluate(() => 'documentExecuted' in window)).toBe(false);
      const read = await second.request.get(documentUrl(fixture.id, file.attachmentId)); expect(read.headers()['cache-control']).toBe('no-store');
      expect((await read.json()).text).toBe(text);
      const anonymous = await browser.newContext();
      try { expect((await anonymous.request.get(documentUrl(fixture.id, file.attachmentId))).status()).toBe(401); } finally { await anonymous.close(); }
      expect((await request.get(`/api/conversations/${fixture.id}/backup`)).status()).toBe(409);
      const copy = await request.post(`/api/conversations/${fixture.id}/duplicate`, { headers, data: { requestId: crypto.randomUUID() } });
      expect(copy.status()).toBe(201); await request.delete(`/api/conversations/${(await copy.json()).id}`, { headers });
    } finally { await first.close(); await second.close(); await fixture.cleanup(); }
  });
}
test('invalid, incomplete, foreign, unparsed and over-budget documents fail before creating a chat task', async ({ request }) => {
  const fixture = await setup(request), other = await setup(request);
  try {
    const good = await upload(request, fixture.id); await parse(request, fixture.id, good.id);
    const unparsed = await upload(request, fixture.id), foreign = await upload(request, other.id); await parse(request, other.id, foreign.id);
    const pending = { id: crypto.randomUUID(), name: 'pending.txt', size: 10, sha256: 'a'.repeat(64), mediaType: 'text/plain' };
    await request.post(`/api/conversations/${fixture.id}/attachments`, { headers, data: pending });
    for (const ids of [[unparsed.id], [foreign.id], [pending.id], [good.id, good.id], Array(5).fill(good.id)]) {
      expect((await fixture.submit({ parentId: null, requestId: crypto.randomUUID(), content: '', selection: fixture.selection, fileIds: ids })).status()).toBeGreaterThanOrEqual(400);
    }
    for (const [bytes, name, mediaType, status] of [
      [Buffer.concat([Buffer.from('valid prefix text '), Buffer.from([0xff])]), 'bad.txt', 'text/plain', 415],
      [Buffer.from('valid prefix text \u001bescape'), 'control.txt', 'text/plain', 415],
      [Buffer.from('a,b\n1'), 'bad.csv', 'text/csv', 415],
      [Buffer.from('x'.repeat(64001)), 'characters.txt', 'text/plain', 413],
      [Buffer.from('中'.repeat(44000)), 'bytes.txt', 'text/plain', 413],
    ] as const) {
      const bad = await upload(request, fixture.id, bytes, name, mediaType);
      const endpoint = documentUrl(fixture.id, bad.id);
      expect((await request.post(endpoint, { headers })).status()).toBe(status);
      expect((await request.post(endpoint, { headers })).status()).toBe(status);
      expect((await fixture.submit({ parentId: null, requestId: crypto.randomUUID(), content: '', selection: fixture.selection, fileIds: [bad.id] })).status()).toBeGreaterThanOrEqual(400);
    }
    expect((await request.post(documentUrl(fixture.id, foreign.id), { headers })).status()).toBe(404);
    expect((await fixture.submit({ parentId: null, requestId: crypto.randomUUID(), content: '', selection: fixture.selection, fileIds: [good.id], settings: { ...((await fixture.snapshot()).settings!), contextBudget: 100 } })).status()).toBe(400);
    expect((await fixture.snapshot()).messages).toHaveLength(0);
    const state = await control(request); expect(state.documents.some((row: { id: string; status: string }) => row.id === good.id && row.status === 'ready')).toBe(true);
  } finally { await fixture.cleanup(); await other.cleanup(); }
});
test('document retries, revisions and summaries retain branch references and protect original and parsed objects', async ({ request }) => {
  const fixture = await setup(request), original = await upload(request, fixture.id); await parse(request, fixture.id, original.id);
  try {
    const first = await submit(fixture, { content: 'expect-files:1', fileIds: [original.id] }); await finish(fixture, first);
    const retried = await submit(fixture, { retryOf: first.assistantId }); await finish(fixture, retried);
    const revised = await submit(fixture, { revisionOf: first.userId, content: 'expect-files:1', fileIds: [original.id] }); await finish(fixture, revised);
    const summary = await submit(fixture, { summaryThrough: revised.assistantId }); await finish(fixture, summary);
    const without = await submit(fixture, { revisionOf: first.userId, content: 'expect-files:0' }); await finish(fixture, without);
    expect(messageFiles((await fixture.snapshot()).messages.find((message) => message.id === without.userId)!)).toEqual([]);
    expect((await request.delete(`/api/conversations/${fixture.id}/attachments/${original.id}`, { headers })).status()).toBe(409);
    await request.delete(`/api/conversations/${fixture.id}/messages/${first.userId}`, { headers });
    expect((await request.delete(`/api/conversations/${fixture.id}/attachments/${original.id}`, { headers })).status()).toBe(409);
    await request.delete(`/api/conversations/${fixture.id}/messages/${revised.userId}`, { headers });
    expect((await request.delete(`/api/conversations/${fixture.id}/attachments/${original.id}`, { headers })).status()).toBe(200);
    await expect.poll(async () => (await control(request)).objects.filter((object: { key: string }) => object.key.includes(`/${original.id}/`)).length).toBe(0);
    expect((await request.get(documentUrl(fixture.id, original.id))).status()).toBe(404);
  } finally { await fixture.cleanup(); }
});
test('image and CSV can share one task and both allowances are included in the context budget', async ({ request }) => {
  const fixture = await setup(request, 'openai-chat', true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  try {
    const image = await upload(request, fixture.id, png, 'image.png', 'image/png');
    const original = await upload(request, fixture.id, Buffer.from('name,value\n"a,b",=SUM(A1)\n'), 'data.csv', 'text/csv'), file = await parse(request, fixture.id, original.id);
    expect(file.csv).toEqual({ rows: 2, columns: 2 });
    const result = await submit(fixture, { content: 'expect-images:1 expect-files:1', imageIds: [image.id], fileIds: [original.id] });
    const answer = await finish(fixture, result); expect(answer.generation?.context?.imageTokens).toBe(4096); expect(answer.generation?.context?.documentTokens).toBe(file.tokens);
  } finally { await fixture.cleanup(); }
});
test('unknown parsed R2 write is cleaned after reset before explicit reparsing, with the original retained', async ({ request }) => {
  const fixture = await setup(request), original = await upload(request, fixture.id);
  try {
    await control(request, { reset: true });
    expect([500, 503]).toContain((await request.post(documentUrl(fixture.id, original.id), { headers })).status());
    const state = await control(request); expect(state.documents.find((row: { id: string }) => row.id === original.id)?.status).toBe('parsing');
    expect(state.objects.filter((object: { key: string }) => object.key.includes(`/${original.id}/`))).toHaveLength(2);
    expect((await fixture.submit({ parentId: null, requestId: crypto.randomUUID(), content: '', selection: fixture.selection, fileIds: [original.id] })).status()).toBe(409);
    await control(request, { id: original.id, expire: true });
    await expect.poll(async () => (await control(request)).documents.some((row: { id: string }) => row.id === original.id)).toBe(false);
    expect((await request.get(attachmentUrl(fixture.id, original.id))).status()).toBe(200);
    expect((await control(request)).objects.filter((object: { key: string }) => object.key.includes(`/${original.id}/`))).toHaveLength(1);
    await parse(request, fixture.id, original.id); expect((await fixture.snapshot()).messages).toHaveLength(0);
    await finish(fixture, await submit(fixture, { content: '', fileIds: [original.id] }));
  } finally { await control(request, { reset: false }); await fixture.cleanup(); }
});
test('deletion interleaved with parsing or acceptance never leaves an orphan or accepts a removed file', async ({ request }) => {
  const fixture = await setup(request), original = await upload(request, fixture.id);
  try {
    await control(request, { holdTextPut: original.id });
    const parsing = request.post(documentUrl(fixture.id, original.id), { headers });
    await expect.poll(async () => (await control(request)).textWaiting).toBe(true);
    expect((await request.delete(`/api/conversations/${fixture.id}/attachments/${original.id}`, { headers })).status()).toBe(200);
    await control(request, { releaseText: true }); expect((await parsing).status()).toBe(404);
    await expect.poll(async () => (await control(request)).objects.some((object: { key: string }) => object.key.includes(`/${original.id}/`))).toBe(false);
    const next = await upload(request, fixture.id); await parse(request, fixture.id, next.id);
    await control(request, { holdTextRead: next.id });
    const accepting = fixture.submit({ parentId: null, requestId: crypto.randomUUID(), content: '', selection: fixture.selection, fileIds: [next.id] });
    await expect.poll(async () => (await control(request)).textWaiting).toBe(true);
    expect((await request.delete(`/api/conversations/${fixture.id}/attachments/${next.id}`, { headers })).status()).toBe(200);
    await control(request, { releaseText: true }); expect((await accepting).status()).toBeGreaterThanOrEqual(400);
    expect((await fixture.snapshot()).messages).toHaveLength(0);
    await expect.poll(async () => (await control(request)).objects.some((object: { key: string }) => object.key.includes(`/${next.id}/`))).toBe(false);
  } finally { await control(request, { releaseText: true }); await fixture.cleanup(); }
});
test('new-conversation upload preserves text, focus and private metadata drafts; preview close never sends the composer', async ({ page, request }) => {
  const fixture = await setup(request);
  try {
    await page.goto('/'); await page.getByLabel('访问密码').fill('everchat-local'); await page.getByRole('button', { name: '进入我的空间' }).click();
    await expectChatModel(page, JSON.stringify([providerId, fixture.selection.model]));
    const editor = page.getByRole('textbox', { name: '消息', exact: true }); await editor.fill('保留我的草稿 expect-files:1');
    await page.getByLabel('选择聊天文件').setInputFiles({ name: 'draft.ts', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await expect(page).toHaveURL(/\/c\/[a-f0-9-]+(?:\?branch=[^#]+)?$/); const id = new URL(page.url()).pathname.split('/').at(-1)!;
    try {
      await expect(page.getByRole('button', { name: '预览 draft.ts' })).toBeVisible(); await expect(editor).toHaveValue('保留我的草稿 expect-files:1'); await expect(editor).toBeFocused();
      await page.reload(); await expect(page.getByRole('button', { name: '预览 draft.ts' })).toBeVisible(); await expect(editor).toHaveValue('保留我的草稿 expect-files:1');
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('documentExecuted');
      await page.getByRole('button', { name: '预览 draft.ts' }).click(); await expect(page.getByRole('dialog').locator('pre')).toContainText('预算：42 元');
      await page.getByRole('dialog').getByRole('button', { name: '关闭文件预览', exact: true }).click({ position: { x: 8, y: 8 } });
      await expect(page.getByRole('dialog')).not.toBeVisible();
      expect((await (await request.get(`/api/conversations/${id}`)).json() as Snapshot).messages).toHaveLength(0);
      await page.getByRole('button', { name: '发送消息' }).click(); await expect(page.getByTestId('assistant-message')).toContainText('答案。');
    } finally { await request.delete(`/api/conversations/${id}`, { headers }); }
  } finally { await fixture.cleanup(); }
});
test('file-only offline queue retains references and sends when online; failed parsing preserves the draft', async ({ page, request }) => {
  const fixture = await setup(request);
  try {
    await page.goto(`/c/${fixture.id}`); await page.getByLabel('访问密码').fill('everchat-local'); await page.getByRole('button', { name: '进入我的空间' }).click();
    const editor = page.getByRole('textbox', { name: '消息', exact: true }); await editor.fill('保留失败草稿');
    await page.getByLabel('选择聊天文件').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1') });
    await expect(page.getByRole('alert')).toContainText('CSV'); await expect(editor).toHaveValue('保留失败草稿'); expect((await fixture.snapshot()).messages).toHaveLength(0);
    await page.getByLabel('选择聊天文件').setInputFiles({ name: 'queue.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
    await expect(page.getByRole('button', { name: '预览 queue.md' })).toBeVisible(); await editor.fill('');
    await page.context().setOffline(true); await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
    const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]'));
    expect(queue).toHaveLength(1); expect(queue[0].input.fileIds).toHaveLength(1); expect(JSON.stringify(queue)).not.toContain('documentExecuted');
    await page.context().setOffline(false); await expect(page.getByTestId('assistant-message')).toContainText('答案。');
    expect(messageFiles((await fixture.snapshot()).messages.find((message) => message.role === 'user')!)).toHaveLength(1);
  } finally { await page.context().setOffline(false); await fixture.cleanup(); }
});
test('switching conversations cancels a pending parse and cleans its files without mixing drafts', async ({ page, request }) => {
  const fixture = await setup(request), other = await setup(request);
  let release!: () => void;
  try {
    await page.goto(`/c/${fixture.id}`); await page.getByLabel('访问密码').fill('everchat-local'); await page.getByRole('button', { name: '进入我的空间' }).click();
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let fileId = '';
    await page.route('**/attachments/*/document', async (route) => { fileId = route.request().url().split('/').at(-2)!; await wait; await route.continue().catch(() => {}); });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('来源草稿');
    await page.getByLabel('选择聊天文件').setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await expect.poll(() => fileId).not.toBe('');
    await page.evaluate((id) => { history.pushState(null, '', `/c/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, other.id);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: '取消上传', exact: true })).not.toBeVisible();
    release();
    await expect(page.getByRole('button', { name: '预览 cancel.txt' })).not.toBeVisible();
    await expect.poll(async () => (await request.get(attachmentUrl(fixture.id, fileId))).status()).toBe(404);
    expect((await fixture.snapshot()).messages).toHaveLength(0); expect((await other.snapshot()).messages).toHaveLength(0);
  } finally { release?.(); await fixture.cleanup(); await other.cleanup(); }
});
test('automatic summary consumes persisted old files and then starts the answer with the new file references', async ({ request }) => {
  const fixture = await setup(request);
  try {
    const old = await upload(request, fixture.id, Buffer.from('文件中的预算：42 元 __SUMMARY_FACT_42__'), 'old.md', 'text/markdown'); await parse(request, fixture.id, old.id);
    await finish(fixture, await submit(fixture, { content: `expect-files:1 ${'history '.repeat(220)}`, fileIds: [old.id] }));
    const current = await upload(request, fixture.id), file = await parse(request, fixture.id, current.id);
    const result = await submit(fixture, { content: 'expect-files:1', fileIds: [current.id], settings: { ...DEFAULT_CONVERSATION_SETTINGS, contextBudget: 1100,
      autoCompression: { enabled: true, threshold: 50, model: { providerId, model: 'benchmark-summary-good' } } } });
    expect(result.summaryId).toBeTruthy();
    const answer = await finish(fixture, result), snapshot = await fixture.snapshot();
    expect(messageText(snapshot.messages.find((message) => message.id === result.summaryId)!)).toContain('__SUMMARY_FACT_42__');
    expect(answer.generation?.context?.documentTokens).toBe(file.tokens);
    expect(messageFiles(snapshot.messages.find((message) => message.id === result.userId)!)).toEqual([file]);
  } finally { await fixture.cleanup(); }
});
test('mobile long-file preview scrolls independently and remote conversation deletion clears its draft', async ({ page, request }) => {
  const fixture = await setup(request);
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/c/${fixture.id}`);
    await page.getByLabel('访问密码').fill('everchat-local'); await page.getByRole('button', { name: '进入我的空间' }).click();
    await page.getByLabel('选择聊天文件').setInputFiles({ name: 'long.txt', mimeType: 'text/plain', buffer: Buffer.from('line '.repeat(12000)) });
    await page.getByRole('button', { name: '预览 long.txt' }).click();
    await expect(page.getByRole('dialog').locator('pre')).toContainText('line');
    await page.getByRole('dialog').locator('pre').evaluate((pre) => { pre.parentElement!.scrollTop = pre.parentElement!.scrollHeight; });
    const close = page.getByRole('button', { name: '关闭文件预览' }); await expect(close).toBeInViewport(); await close.click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await fixture.cleanup(); await expect(page.getByRole('button', { name: '预览 long.txt' })).not.toBeVisible();
    const draft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`everchat:draft:${id}`) ?? '{}'), fixture.id);
    expect(draft.files ?? []).toEqual([]);
  } finally { await fixture.cleanup(); }
});
