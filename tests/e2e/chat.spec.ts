import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:5173';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
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
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:selected')!));
  const initial = await context.request.get(`/api/conversations/${id}`).then((response) => response.json());
  expect(initial.messages).toHaveLength(2);
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('离线');

  const second = await browser.newContext();
  const otherPage = await second.newPage();
  await login(otherPage);
  await otherPage.getByRole('button', { name: prompt }).click();
  await expect(otherPage.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await context.setOffline(false);
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
  const firstText = await page.getByTestId('assistant-message').innerText();
  expect(await otherPage.getByTestId('assistant-message').innerText()).toBe(firstText);

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
  expect(final.messages[3].content).toContain('现在，把注意力');
  await second.close();
});

test('offline outbox is persisted, delivered once, and cancellation preserves progress', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await page.getByLabel('消息', { exact: true }).fill('这条消息先离线保存');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已保存在此设备 · 等待云端确认')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!));
  expect(saved).toHaveLength(1);
  await context.setOffline(false);
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('assistant-message')).toContainText('演示回答');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'cancelled');
  expect(await page.getByTestId('assistant-message').innerText()).toContain('演示回答');
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
  await expect(page.getByRole('heading', { name: '让对话， 继续发生。' })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '收起侧栏' })).not.toBeInViewport();
  await page.screenshot({ path: 'test-results/mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '打开对话列表' }).click();
  await expect(page.getByRole('button', { name: '开启新对话' })).toBeVisible();
  await page.getByRole('button', { name: '收起侧栏' }).click();
});
