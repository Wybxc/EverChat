import { openSpaceSettings } from '../ui';
import { messageText } from '../../shared/message-content';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:5174';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const response = await page.request.put('/api/settings/providers', { headers: { Origin: origin }, data: {
    providers: [{ id: '00000000-0000-4000-8000-000000000099', name: 'Integration', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', models: [{ id: 'test-model', name: 'test-model', enabled: true }], apiKey: 'integration-test-key' }],
    activeProviderId: '00000000-0000-4000-8000-000000000099', activeModel: 'test-model', systemPrompt: '', maxOutputTokens: 128,
  } });
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}
async function newConversation(context: BrowserContext, title = 'Integration test') {
  const id = randomUUID();
  const response = await context.request.post('/api/conversations', { headers: { Origin: origin }, data: { id, title } });
  expect(response.status()).toBe(201);
  return id;
}

test('private API requires authentication and rejects cross-origin writes', async ({ request, page }) => {
  expect((await request.get('/api/conversations')).status()).toBe(401);
  expect((await request.post('/api/login', { headers: { Origin: 'https://untrusted.invalid' }, data: { password: 'everchat-local' } })).status()).toBe(403);
  await page.goto('/');
  await page.getByLabel('访问密码').fill('incorrect-password');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByRole('alert')).toContainText('不正确');
});

test('generation survives offline, tab closure and a second device; retries are idempotent', async ({ page, context, browser }) => {
  await login(page);
  const prompt = `跨设备测试 ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('消息', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'running');
  const id = new URL(page.url()).pathname.split('/')[2];
  const initial = await context.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(initial.messages).toHaveLength(2);
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('离线');

  const second = await browser.newContext();
  const otherPage = await second.newPage();
  await login(otherPage);
  await otherPage.getByRole('link', { name: prompt }).click();
  await expect(otherPage.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await context.setOffline(false);
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('assistant-message')).toContainText('服务端生成完成');
  // Reconnection can expose the plain-text Suspense fallback before the Markdown chunk loads.
  // Wait for both devices to render before capturing the text used for comparison.
  for (const device of [page, otherPage]) {
    await expect(device.getByTestId('assistant-message').locator('[data-streamdown="strong"]')).toHaveText('集成测试回答。');
  }
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    context.request.get(`/api/conversations/${id}`).then((response) => response.json()),
    second.request.get(`/api/conversations/${id}`).then((response) => response.json()),
  ]);
  expect(secondSnapshot).toEqual(firstSnapshot);
  const firstText = (await page.getByTestId('assistant-message').innerText()).replace(/\s+/g, '');
  await expect.poll(async () => (await otherPage.getByTestId('assistant-message').innerText()).replace(/\s+/g, '')).toBe(firstText);

  const input = { requestId: randomUUID(), content: '关闭页面也继续生成' };
  const first = await context.request.post(`/api/conversations/${id}/messages`, { headers: { Origin: origin }, data: input });
  const duplicate = await context.request.post(`/api/conversations/${id}/messages`, { headers: { Origin: origin }, data: input });
  expect(first.status()).toBe(202); expect(duplicate.status()).toBe(202);
  expect(await duplicate.json()).toEqual(await first.json());
  const competing = await context.request.post(`/api/conversations/${id}/messages`, { headers: { Origin: origin }, data: { requestId: randomUUID(), content: '不应并发' } });
  expect(competing.status()).toBe(409);
  await page.close();
  await expect(otherPage.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  const final = await second.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(final.messages).toHaveLength(4);
  expect(messageText(final.messages[3])).toContain('服务端生成完成');
  const settings = await context.request.get('/api/settings/providers').then((response) => response.json());
  try {
    expect((await context.request.put('/api/settings/providers', { headers: { Origin: origin }, data: { ...settings, activeProviderId: null, activeModel: '' } })).status()).toBe(200);
    const replay = await context.request.post(`/api/conversations/${id}/messages`, { headers: { Origin: origin }, data: input });
    expect(replay.status()).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
  } finally {
    expect((await context.request.put('/api/settings/providers', { headers: { Origin: origin }, data: settings })).status()).toBe(200);
  }
  await second.close();
});

test('offline outbox is persisted, delivered once, and cancellation preserves progress', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await page.getByLabel('消息', { exact: true }).fill('这条消息先离线保存');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!));
  expect(saved).toHaveLength(1);
  await context.setOffline(false);
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('assistant-message')).toContainText('集成测试回答');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'cancelled');
  expect(await page.getByTestId('assistant-message').innerText()).toContain('集成测试回答');
  await page.getByRole('button', { name: '重新生成' }).click();
  await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(page.getByTestId('assistant-message').first()).toHaveAttribute('data-status', 'cancelled');
});

test('mobile and desktop layouts fit their viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/login-desktop.png' });
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByRole('heading', { name: '新对话' })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '收起侧栏' })).not.toBeInViewport();
  await page.screenshot({ path: 'test-results/mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '打开对话列表' }).click();
  await expect(page.getByRole('button', { name: '开启新对话' })).toBeVisible();
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await openSpaceSettings(page);
  await page.getByRole('radio', { name: '深色' }).focus();
  await page.getByRole('radio', { name: '深色' }).press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openSpaceSettings(page);
  await page.getByRole('radio', { name: '浅色' }).focus();
  await page.getByRole('radio', { name: '浅色' }).press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('new conversation moves keyboard focus to the composer', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '开启新对话' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
});

test('system theme follows the operating-system color preference', async ({ page }) => {
  await login(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSpaceSettings(page);
  await page.getByRole('radio', { name: '系统' }).focus();
  await page.getByRole('radio', { name: '系统' }).press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('the composer uses the selected model and shows opt-in provider thoughts', async ({ page, context }) => {
  await login(page);
  const settings = await context.request.get('/api/settings/providers').then((response) => response.json());
  const model = settings.providers[0].models[0];
  model.reasoningSupport = 'supported';
  settings.providers[0].models.push({ id: 'test-model-2', name: '第二模型', enabled: true, reasoningSupport: 'supported' });
  settings.showReasoning = true;
  expect((await context.request.put('/api/settings/providers', { headers: { Origin: origin }, data: settings })).status()).toBe(200);
  const invalidConversationId = randomUUID();
  expect((await context.request.post('/api/conversations', { headers: { Origin: origin }, data: { id: invalidConversationId, title: 'Invalid effort' } })).status()).toBe(201);
  const unsupported = await context.request.post(`/api/conversations/${invalidConversationId}/messages`, { headers: { Origin: origin }, data: {
    requestId: randomUUID(), content: '不应开始', selection: { providerId: settings.providers[0].id, model: 'test-model-2' }, reasoningEffort: 'max',
  } });
  expect(unsupported.status()).toBe(400);
  expect(await unsupported.json()).toMatchObject({ error: '所选模型不支持此思维强度。' });
  await page.reload();
  await page.getByLabel('聊天模型').selectOption(JSON.stringify([settings.providers[0].id, 'test-model-2']));
  await expect(page.getByLabel('聊天模型')).toHaveValue(JSON.stringify([settings.providers[0].id, 'test-model-2']));
  await page.getByLabel('思维强度').selectOption('high');
  await page.getByLabel('消息', { exact: true }).fill('用选定模型回答');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const answer = page.getByTestId('assistant-message');
  await expect(answer).toHaveAttribute('data-status', 'running');
  await expect(answer.getByTestId('message-reasoning').locator('[data-streamdown="strong"]').filter({ hasText: '集成思考。' })).toBeVisible();
  await expect(answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' })).toBeVisible();
  await expect(answer).toHaveAttribute('data-status', 'running');
  await answer.getByTestId('message-reasoning').locator('summary').click();
  await expect(answer.getByTestId('message-reasoning')).toHaveJSProperty('open', false);
  await expect(answer).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(answer.getByTestId('message-reasoning')).toHaveJSProperty('open', false);
  await answer.getByTestId('message-reasoning').locator('summary').click();
  await expect(answer).toContainText('第二模型：'); await expect(answer).toContainText('第二模型');
  await expect(answer.getByTestId('message-reasoning')).toContainText('集成思考。');
  await expect(answer.getByTestId('message-reasoning')).toHaveJSProperty('open', true);
  await expect(answer.getByTestId('message-reasoning').locator('.collapse-content [data-streamdown="strong"]')).toContainText('集成思考。');
  const id = new URL(page.url()).pathname.split('/')[2];
  const snapshot = await context.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(snapshot.messages[1]).toMatchObject({ model: 'test-model-2', modelName: '第二模型', parts: expect.arrayContaining([{ type: 'reasoning', text: '**集成思考。**' }]) });

  await page.getByLabel('聊天模型').selectOption(JSON.stringify([settings.providers[0].id, 'test-model']));
  await answer.getByRole('button', { name: '重新生成' }).click();
  const retry = page.getByTestId('assistant-message').last();
  await expect(retry).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(retry).toContainText('第二模型：');
  const retried = await context.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(retried.messages.at(-1)).toMatchObject({ model: 'test-model-2', modelName: '第二模型' });
});

test('DeepSeek-compatible Responses streams Markdown thoughts, persists them and renders them after reload', async ({ page, context }) => {
  await login(page);
  const settings = await context.request.get('/api/settings/providers').then((response) => response.json());
  settings.providers[0].provider = 'openai-responses';
  settings.providers[0].models = [{ id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true }];
  settings.activeModel = 'deepseek-flash';
  settings.showReasoning = true;
  expect((await context.request.put('/api/settings/providers', { headers: { Origin: origin }, data: settings })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: '开启新对话' }).click();
  await page.getByLabel('思维强度').selectOption('low');
  await page.getByLabel('消息', { exact: true }).fill('测试 Responses 思考内容');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const answer = page.getByTestId('assistant-message');
  const thoughts = answer.getByTestId('message-reasoning');
  await expect(thoughts.locator('[data-streamdown="strong"]')).toHaveText('集成思考。');
  await expect(thoughts.locator('[data-streamdown="strong"]')).toBeVisible();
  await expect(answer).toHaveAttribute('data-status', 'running');
  await expect(answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' })).toHaveCount(0);
  await expect(answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' })).toBeVisible();
  await expect(answer).toHaveAttribute('data-status', 'running');
  await expect(answer).toHaveAttribute('data-status', 'completed');
  const id = new URL(page.url()).pathname.split('/')[2];
  const snapshot = await context.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(snapshot.messages[1]).toMatchObject({ model: 'deepseek-flash', parts: expect.arrayContaining([{ type: 'reasoning', text: '**集成思考。**' }]) });
  await page.reload();
  await expect(thoughts.locator('[data-streamdown="strong"]')).toBeVisible();
  await thoughts.getByText('思考过程', { exact: true }).click();
  await expect(thoughts.locator('[data-streamdown="strong"]')).not.toBeVisible();
  await thoughts.getByText('思考过程', { exact: true }).click();
  await expect(thoughts.locator('[data-streamdown="strong"]')).toBeVisible();
});

test('streaming answers and thoughts follow the bottom, pause when scrolled up and resume at the bottom', async ({ page, context }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await login(page);
  const settings = await context.request.get('/api/settings/providers').then((response) => response.json());
  settings.providers[0].models = [{ id: 'scroll-test', name: '滚动测试', enabled: true }];
  settings.activeModel = 'scroll-test';
  settings.showReasoning = true;
  expect((await context.request.put('/api/settings/providers', { headers: { Origin: origin }, data: settings })).status()).toBe(200);
  await page.reload();
  await page.getByLabel('消息', { exact: true }).fill('持续生成，验证滚动');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const answer = page.getByTestId('assistant-message');
  const conversation = page.getByRole('region', { name: '对话消息' }).locator('..');
  const thoughts = answer.getByTestId('message-reasoning').locator('.overflow-y-auto');
  const metrics = (pane: typeof conversation) => pane.evaluate((node) => ({
    top: node.scrollTop, height: node.scrollHeight, gap: node.scrollHeight - node.scrollTop - node.clientHeight,
    overflow: node.scrollHeight - node.clientHeight,
  }));
  await expect.poll(async () => (await metrics(conversation)).overflow).toBeGreaterThan(400);
  await expect.poll(async () => (await metrics(thoughts)).overflow).toBeGreaterThan(300);
  const initial = await metrics(conversation);
  const initialThoughts = await metrics(thoughts);
  await expect.poll(async () => (await metrics(conversation)).height).toBeGreaterThan(initial.height + 100);
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);
  await expect.poll(async () => (await metrics(thoughts)).height).toBeGreaterThan(initialThoughts.height + 100);
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  await expect(answer).toHaveAttribute('data-status', 'running');

  await conversation.evaluate((node) => { node.scrollTop -= 250; });
  await expect(page.getByRole('button', { name: '滚动到最新消息' })).toBeVisible();
  const reading = await metrics(conversation);
  await expect.poll(async () => (await metrics(conversation)).height).toBeGreaterThan(reading.height + 100);
  expect((await metrics(conversation)).top).toBeCloseTo(reading.top, 0);
  await page.getByRole('button', { name: '滚动到最新消息' }).click();
  const resumed = await metrics(conversation);
  await expect.poll(async () => (await metrics(conversation)).height).toBeGreaterThan(resumed.height + 100);
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);

  await thoughts.evaluate((node) => { node.scrollTop -= 250; });
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeGreaterThan(100);
  const readingThoughts = await metrics(thoughts);
  await expect.poll(async () => (await metrics(thoughts)).height).toBeGreaterThan(readingThoughts.height + 100);
  expect((await metrics(thoughts)).top).toBeCloseTo(readingThoughts.top, 0);
  await thoughts.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  const resumedThoughts = await metrics(thoughts);
  await expect.poll(async () => (await metrics(thoughts)).height).toBeGreaterThan(resumedThoughts.height + 100);
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  await expect(answer).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);
  await conversation.evaluate((node) => { node.scrollTop -= 250; });
  await expect(page.getByRole('button', { name: '滚动到最新消息' })).toBeVisible();
  await page.getByRole('button', { name: '打开对话列表' }).click();
  await page.getByRole('button', { name: '开启新对话' }).click();
  await expect(page.getByRole('heading', { name: '新对话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '滚动到最新消息' })).toHaveCount(0);
});
