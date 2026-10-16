import { conversationMenu } from '../ui';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { attachmentUrl, MAX_ATTACHMENT_BYTES, MAX_CONVERSATION_ATTACHMENTS, type Attachment, type AttachmentInput } from '../../shared/attachments';
const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '附件存储' } })).status()).toBe(201);
  return { id, list: () => request.get(`/api/conversations/${id}/attachments`).then((response) => response.json()) as Promise<Attachment[]>,
    register: (input: AttachmentInput) => request.post(`/api/conversations/${id}/attachments`, { headers, data: input }),
    remove: (fileId: string) => request.delete(`/api/conversations/${id}/attachments/${fileId}`, { headers }),
    cleanup: () => request.delete(`/api/conversations/${id}`, { headers }) };
}
const file = (bytes: Buffer, name = '预算.md', mediaType: AttachmentInput['mediaType'] = 'text/markdown'): AttachmentInput => ({ id: crypto.randomUUID(), name,
  size: bytes.length, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') });
const storage = (request: APIRequestContext, data: { id?: string; expire?: boolean; count?: number; reset?: boolean; holdDelete?: string; releaseDelete?: boolean; failDelete?: string; resetLibrary?: boolean; unconfigured?: boolean } = {}) => request.post('/api/__test/library/attachments', { headers, data }).then((response) => response.json()) as Promise<{ rows: { id: string; conversationId: string; status: string; removed: number; lease: number }[]; objects: { key: string; size: number }[]; dailyCount: number; deleteWaiting: boolean; failedDeletes: number; unconfiguredStatus: number[] }>;
test('private R2 upload preserves Unicode bytes, validates integrity, is idempotent and supports another device', async ({ request, browser }) => {
  const fixture = await setup(request), other = await browser.newContext(), bytes = Buffer.from('# 预算\n42 元🙂'), input = file(bytes);
  try {
    expect((await fixture.register(input)).status()).toBe(201);
    expect(await fixture.list()).toEqual([expect.objectContaining({ ...input, status: 'registered' })]);
    const url = attachmentUrl(fixture.id, input.id);
    expect((await request.get(url)).status()).toBe(409);
    const uploaded = await request.put(url, { headers, data: bytes }); expect(uploaded.status()).toBe(200);
    expect(await uploaded.json()).toMatchObject({ ...input, status: 'ready' });
    expect((await request.put(url, { headers, data: bytes })).status()).toBe(200);
    expect((await fixture.register(input)).status()).toBe(201); expect(await fixture.list()).toHaveLength(1);
    const downloaded = await request.get(url); expect(downloaded.headers()['cache-control']).toBe('no-store');
    expect(downloaded.headers()['content-disposition']).toContain(encodeURIComponent(input.name)); expect(await downloaded.body()).toEqual(bytes);
    const head = await request.head(url); expect(head.status()).toBe(200); expect(head.headers()['content-length']).toBe(String(bytes.length));
    expect((await other.request.get(url)).status()).toBe(401);
    await other.request.post('/api/login', { headers, data: { password: 'everchat-local' } }); expect(await (await other.request.get(url)).body()).toEqual(bytes);
    expect((await fixture.remove(input.id)).status()).toBe(200); expect((await request.get(url)).status()).toBe(404); expect(await fixture.list()).toEqual([]);
    await expect.poll(async () => (await storage(request)).objects.filter((object) => object.key.includes(input.id))).toEqual([]);
  } finally { await other.close(); await fixture.cleanup(); }
});

test('a maximum-size file streams through the Worker and DO and returns exactly the original bytes', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 'x'), input = file(bytes, 'large.txt', 'text/plain');
  try {
    expect((await fixture.register(input)).status()).toBe(201);
    const url = attachmentUrl(fixture.id, input.id); expect((await request.put(url, { headers, data: bytes })).status()).toBe(200);
    expect((await request.head(url)).headers()['content-length']).toBe(String(MAX_ATTACHMENT_BYTES));
    expect(await (await request.get(url)).body()).toEqual(bytes);
  } finally { await fixture.cleanup(); }
});

test('a failed R2 delete retains its reservation across a Library reset and the scheduled retry finishes conversation cleanup', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.from('durable cleanup'), input = file(bytes), before = (await storage(request)).failedDeletes;
  try {
    await fixture.register(input); expect((await request.put(attachmentUrl(fixture.id, input.id), { headers, data: bytes })).status()).toBe(200);
    await storage(request, { failDelete: input.id }); await fixture.cleanup();
    expect((await request.get(attachmentUrl(fixture.id, input.id))).status()).toBe(410);
    await expect.poll(async () => (await storage(request)).failedDeletes).toBe(before + 1);
    const failed = await storage(request); expect(failed.rows.find((row) => row.id === input.id)).toMatchObject({ removed: 1 });
    expect(failed.objects.some((object) => object.key.includes(input.id))).toBe(true);
    expect(failed.rows.find((row) => row.id === input.id)!.lease).toBeGreaterThan(Date.now());
    await request.post('/api/__test/library/attachments', { headers, data: { resetLibrary: true } }).catch(() => {});
    expect((await storage(request)).rows.some((row) => row.id === input.id)).toBe(true);
    await expect.poll(async () => (await storage(request)).rows.some((row) => row.id === input.id), { timeout: 45_000 }).toBe(false);
    expect((await storage(request)).objects.some((object) => object.key.includes(input.id))).toBe(false);
  } finally { await fixture.cleanup(); }
});

test('without an R2 binding storage is explicitly unavailable and its hidden entry leaves the conversation usable', async ({ page }) => {
  const fixture = await setup(page.request);
  try {
    const before = await storage(page.request), state = await storage(page.request, { unconfigured: true });
    expect(state.unconfiguredStatus).toEqual([503, 503]); expect(state.rows).toEqual(before.rows);
    await page.route('**/api/session', async (route) => {
      const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), attachmentsConfigured: false } });
    });
    await page.goto(`/c/${fixture.id}`); await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '管理对话文件', exact: true })).toHaveCount(0);
    await page.getByLabel('消息', { exact: true }).fill('普通聊天草稿'); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('普通聊天草稿');
  } finally { await fixture.cleanup(); }
});
test('expired registrations release reservations, completed files survive expiry and daily attempts cannot bypass the operation budget', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.from('budgeted file'), expired = file(bytes), ready = file(bytes);
  const before = (await storage(request)).dailyCount;
  try {
    await fixture.register(expired); await storage(request, { id: expired.id, expire: true });
    await expect.poll(async () => (await fixture.list()).some((item) => item.id === expired.id)).toBe(false);
    await fixture.register(ready); expect((await request.put(attachmentUrl(fixture.id, ready.id), { headers, data: bytes })).status()).toBe(200);
    await storage(request, { id: ready.id, expire: true }); await expect.poll(async () => (await storage(request)).rows.find((row) => row.id === ready.id)?.status).toBe('ready');
    await storage(request, { count: 100 }); const blocked = file(bytes); await fixture.register(blocked);
    expect((await request.put(attachmentUrl(fixture.id, blocked.id), { headers, data: bytes })).status()).toBe(429);
    expect((await request.put(attachmentUrl(fixture.id, ready.id), { headers, data: bytes })).status()).toBe(200);
    expect((await storage(request)).dailyCount).toBe(100);
  } finally { await storage(request, { count: before }); await fixture.cleanup(); }
});

test('cleanup closes expired registrations before R2 deletion and rechecks later reservations claimed during its wait', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.from('survives interleaved cleanup'), first = file(bytes), second = file(bytes);
  try {
    await fixture.register(first); await fixture.register(second);
    await storage(request, { id: first.id, expire: true, holdDelete: first.id }); await storage(request, { id: second.id, expire: true });
    await expect.poll(async () => (await storage(request)).deleteWaiting).toBe(true);
    expect((await request.put(attachmentUrl(fixture.id, first.id), { headers, data: bytes })).status()).toBe(404);
    expect((await request.put(attachmentUrl(fixture.id, second.id), { headers, data: bytes })).status()).toBe(200);
    await storage(request, { releaseDelete: true });
    await expect.poll(async () => (await storage(request)).rows.some((row) => row.id === first.id)).toBe(false);
    expect(await (await request.get(attachmentUrl(fixture.id, second.id))).body()).toEqual(bytes);
    expect((await fixture.list()).map(({ id }) => id)).toEqual([second.id]);
  } finally { await storage(request, { releaseDelete: true }); await fixture.cleanup(); }
});

test('concurrent registrations cannot exceed conversation byte or file-count reservations', async ({ request }) => {
  const large = await setup(request), many = await setup(request), bytes = Buffer.from('reserved');
  try {
    for (let index = 0; index < 6; index++) expect((await large.register({ ...file(bytes), size: MAX_ATTACHMENT_BYTES })).status()).toBe(201);
    const room = await Promise.all([large.register({ ...file(bytes), size: 2 * 1024 * 1024 }), large.register({ ...file(bytes), size: 2 * 1024 * 1024 })]);
    expect(room.map((response) => response.status()).sort()).toEqual([201, 507]);
    expect((await large.list()).reduce((sum, item) => sum + item.size, 0)).toBe(32 * 1024 * 1024);
    for (let index = 0; index < MAX_CONVERSATION_ATTACHMENTS - 1; index++) expect((await many.register(file(bytes))).status()).toBe(201);
    const last = await Promise.all([many.register(file(bytes)), many.register(file(bytes))]);
    expect(last.map((response) => response.status()).sort()).toEqual([201, 507]); expect(await many.list()).toHaveLength(MAX_CONVERSATION_ATTACHMENTS);
  } finally { await large.cleanup(); await many.cleanup(); }
});

test('the file manager uploads with progress, preserves the composer and URL, syncs another device and restores focus', async ({ page, browser }) => {
  const fixture = await setup(page.request), other = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    await page.goto(`/c/${fixture.id}`); const composer = page.getByLabel('消息', { exact: true }); await composer.fill('保留草稿');
    await conversationMenu(page); await page.getByRole('menuitem', { name: '管理对话文件', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '对话文件', exact: true });
    await expect(dialog.getByLabel('上传文件', { exact: true })).toBeFocused();
    await page.route('**/api/conversations/*/attachments/*/content', async (route) => {
      if (route.request().method() === 'PUT') { const response = await route.fetch(); await new Promise((resolve) => setTimeout(resolve, 400)); await route.fulfill({ response }); }
      else await route.continue();
    });
    const bytes = Buffer.from('# 文件\n42 元🙂'); await dialog.getByLabel('上传文件', { exact: true }).setInputFiles({ name: '预算.md', mimeType: 'text/markdown', buffer: bytes });
    await expect(dialog.getByRole('progressbar', { name: '上传进度' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: '下载', exact: true })).toBeVisible(); await expect(dialog).toContainText('已保存');
    const second = await other.newPage(); await second.goto(`/c/${fixture.id}`); await conversationMenu(second); await second.getByRole('menuitem', { name: '管理对话文件', exact: true }).click();
    await expect(second.getByRole('dialog', { name: '对话文件', exact: true })).toContainText('预算.md');
    await dialog.getByRole('button', { name: '关闭对话文件' }).click(); await expect(page.getByRole('button', { name: '更多会话操作', exact: true })).toBeFocused();
    await expect(composer).toHaveValue('保留草稿'); await expect(page).toHaveURL((url) => url.pathname === `/c/${fixture.id}`);
    await page.reload(); await conversationMenu(page); await page.getByRole('menuitem', { name: '管理对话文件', exact: true }).click(); await expect(dialog).toContainText('预算.md');
    await dialog.getByRole('button', { name: '删除文件 预算.md', exact: true }).click(); await expect(dialog).toContainText('暂无文件');
    await expect(second.getByRole('dialog', { name: '对话文件', exact: true })).toContainText('暂无文件');
  } finally { await other.close(); await fixture.cleanup(); }
});

test('a reset after R2 write never exposes an uncommitted upload, and the durable lease cleans its object without another write', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.from('saved before reset'), input = file(bytes);
  try {
    await fixture.register(input); const before = (await storage(request)).dailyCount; await storage(request, { reset: true });
    const response = await request.put(attachmentUrl(fixture.id, input.id), { headers, data: bytes }); expect(response.ok()).toBe(false);
    expect((await request.get(attachmentUrl(fixture.id, input.id))).status()).toBe(409);
    const state = await storage(request); expect(state.objects.some((object) => object.key.includes(input.id))).toBe(true);
    expect(state.rows.find((row) => row.id === input.id)?.status).toBe('uploading'); expect(state.dailyCount).toBe(before + 1);
    expect((await request.put(attachmentUrl(fixture.id, input.id), { headers, data: bytes })).status()).toBe(409);
    expect((await storage(request)).dailyCount).toBe(before + 1);
    await storage(request, { id: input.id, expire: true });
    await expect.poll(async () => (await storage(request)).objects.filter((object) => object.key.includes(input.id))).toEqual([]);
    expect((await storage(request)).rows.some((row) => row.id === input.id)).toBe(false);
  } finally { await storage(request, { reset: false }); await fixture.cleanup(); }
});

test('client cancellation removes the accepted registration, while a mobile file list keeps its close control visible', async ({ page }) => {
  const fixture = await setup(page.request); let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }), sent = new Promise<void>((resolve) => { arrived = resolve; });
  try {
    await page.setViewportSize({ width: 390, height: 780 }); await page.goto(`/c/${fixture.id}`);
    await conversationMenu(page); await page.getByRole('menuitem', { name: '管理对话文件', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '对话文件', exact: true });
    await page.route('**/api/conversations/*/attachments/*/content', async (route) => { if (route.request().method() !== 'PUT') return route.continue(); arrived(); await held; await route.continue().catch(() => {}); });
    await dialog.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('pending file') }); await sent;
    await dialog.getByRole('button', { name: '取消上传', exact: true }).click(); await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    await expect.poll(fixture.list).toEqual([]); release(); await page.unroute('**/api/conversations/*/attachments/*/content');
    for (let index = 0; index < 20; index++) await fixture.register(file(Buffer.from('file'), `第 ${index} 个文件.txt`, 'text/plain'));
    await expect(dialog.getByRole('listitem')).toHaveCount(20);
    await dialog.locator('.overflow-y-auto').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(dialog.getByRole('button', { name: '关闭对话文件' })).toBeInViewport(); await dialog.getByRole('button', { name: '关闭对话文件' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { release(); await fixture.cleanup(); }
});
test('attachment routes reject unauthorized, cross-origin, foreign-conversation, oversized and conflicting uploads without making content readable', async ({ request, browser }) => {
  const fixture = await setup(request), other = await browser.newContext(), bytes = Buffer.from('bounded text'), input = file(bytes);
  try {
    expect((await other.request.post(`/api/conversations/${fixture.id}/attachments`, { headers, data: input })).status()).toBe(401);
    expect((await request.post(`/api/conversations/${fixture.id}/attachments`, { headers: { Origin: 'https://foreign.test' }, data: input })).status()).toBe(403);
    expect((await fixture.register({ ...input, size: MAX_ATTACHMENT_BYTES + 1 })).status()).toBe(400);
    expect((await fixture.register(input)).status()).toBe(201);
    expect((await fixture.register({ ...input, sha256: 'b'.repeat(64) })).status()).toBe(409);
    const second = crypto.randomUUID(); await request.post('/api/conversations', { headers, data: { id: second, title: '其他对话' } });
    try { expect((await request.put(attachmentUrl(second, input.id), { headers, data: bytes })).status()).toBe(404); }
    finally { await request.delete(`/api/conversations/${second}`, { headers }); }
    const url = attachmentUrl(fixture.id, input.id), bad = await request.put(url, { headers, data: Buffer.from('different bytes') });
    expect([400,413]).toContain(bad.status()); expect((await request.get(url)).status()).not.toBe(200);
  } finally { await other.close(); await fixture.cleanup(); }
});
test('spoofed media, truncated bytes and a checksum mismatch never become ready; conversation deletion revokes reads', async ({ request }) => {
  const fixture = await setup(request), bytes = Buffer.from('plain text payload');
  try {
    const invalid = [file(bytes, 'fake.png', 'image/png'), { ...file(bytes), size: bytes.length + 1 }, { ...file(bytes), sha256: 'a'.repeat(64) }];
    for (const input of invalid) {
      expect((await fixture.register(input)).status()).toBe(201);
      const url = attachmentUrl(fixture.id, input.id), uploaded = await request.put(url, { headers, data: bytes });
      expect([400,415]).toContain(uploaded.status()); expect((await request.get(url)).status()).not.toBe(200);
    }
    const valid = file(bytes); await fixture.register(valid); expect((await request.put(attachmentUrl(fixture.id, valid.id), { headers, data: bytes })).status()).toBe(200);
    await fixture.cleanup(); expect((await request.get(attachmentUrl(fixture.id, valid.id))).status()).toBe(410);
  } finally { await fixture.cleanup(); }
});
