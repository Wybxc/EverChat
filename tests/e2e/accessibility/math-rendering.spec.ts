import { expect,test,type APIRequestContext } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';

const headers = { Origin: 'http://127.0.0.1:5174' };
const examples = [
  String.raw`行内美元：$E = mc^2$。`,
  String.raw`行内括号：\(a^2 + b^2 = c^2\)。`,
  String.raw`块级美元：

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$`,
  String.raw`块级方括号：

\[
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\]`,
  '价格是 $5 和 $10；转义美元 \\$x$。行内代码 `$x^2$` 和 `\\(x\\)`。\n\n```text\n$$x^2$$\n\\[x\\]\n```',
  `$$\n${Array.from({ length: 35 }, (_, i) => `x_{${i}}^2`).join(' + ')} = 0\n$$`,
];

async function fixture(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const empty = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id: empty, title: '数学公式验证' } })).status()).toBe(201);
  const backup = await request.get(`/api/conversations/${empty}/backup`).then((response) => response.json());
  const ids = Array.from({ length: examples.length + 1 }, () => crypto.randomUUID());
  backup.conversation.messages = ['公式展示', ...examples].map((text, i) => ({
    id: ids[i], role: i ? 'assistant' : 'user', parts: [{ type: 'text', text }], status: 'completed', createdAt: i,
    parentId: i ? ids[i - 1] : null, revisionOf: null, error: null, providerId: null, model: null, modelName: null,
  }));
  const restored = await request.post('/api/backup/restore', { headers, data: backup });
  expect(restored.status()).toBe(201);
  const { id } = await restored.json() as { id: string };
  return { id, cleanup: async () => {
    await request.delete(`/api/conversations/${id}`, { headers });
    await request.delete(`/api/conversations/${empty}`, { headers });
  } };
}

test('common inline and display math delimiters render while prices and code remain literal', async ({ page }, testInfo) => {
  const f = await fixture(page.request), errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`/c/${f.id}`);
    const answers = page.getByTestId('assistant-message');
    await expect(answers).toHaveCount(examples.length);
    for (let i = 0; i < 4; i++) {
      await expect(answers.nth(i).locator('.katex'), examples[i]).toHaveCount(1);
      await expect(answers.nth(i).locator('.katex-error')).toHaveCount(0);
      await expect(answers.nth(i).locator('.katex-mathml math')).toHaveCount(1);
    }
    await expect(answers.nth(0).locator('.katex-display')).toHaveCount(0);
    await expect(answers.nth(2).locator('.katex-display')).toHaveCount(1);
    await expect(answers.nth(3).locator('.katex-display')).toHaveCount(1);
    await expect(answers.nth(4).locator('.katex')).toHaveCount(0);
    await expect(answers.nth(4)).toContainText('价格是 $5 和 $10');
    await expect(answers.nth(4).locator('pre')).toContainText('$$x^2$$');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator('.katex .mathnormal').first().evaluate((node) => getComputedStyle(node).fontFamily)).toContain('KaTeX');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: testInfo.outputPath(`math-${colorScheme}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test('wide display equations stay horizontally scrollable inside narrow light and dark layouts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const f = await fixture(page.request);
  try {
    await page.goto(`/c/${f.id}`);
    const formula = page.getByTestId('assistant-message').last().locator('.katex-display');
    await expect(formula.locator('.katex')).toHaveCount(1);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await formula.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const metrics = await formula.evaluate((node) => ({ width: node.clientWidth, content: node.scrollWidth, overflow: getComputedStyle(node).overflowX }));
      expect(metrics.overflow).toBe('auto'); expect(metrics.content).toBeGreaterThan(metrics.width);
      await formula.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
      expect(await formula.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath(`wide-math-${colorScheme}.png`) });
    }
  } finally { await f.cleanup(); }
});

test('split streamed delimiters render in both thoughts and answers before completion and survive reload', async ({ page }, testInfo) => {
  const f = await fixture(page.request);
  const settings = await page.request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID(), errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    expect((await page.request.put('/api/settings/providers', { headers, data: {
      providers: [{ id: providerId, name: '公式流式验证', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'integration-test-key',
        models: [{ id: 'benchmark-math', name: '公式流式验证', enabled: true, reasoningSupport: 'supported' }] }],
      activeProviderId: providerId, activeModel: 'benchmark-math', showReasoning: true, systemPrompt: '', maxOutputTokens: null,
    } })).ok()).toBe(true);
    await page.goto(`/c/${f.id}`);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('展示公式');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const answer = page.getByTestId('assistant-message').last();
    await expect(answer.locator('.katex')).toHaveCount(2);
    await expect(answer).toHaveAttribute('data-status', 'running');
    await expect(answer.getByTestId('message-reasoning').locator('.katex')).toHaveCount(1);
    await expect(answer.locator('.katex')).toHaveCount(3);
    await expect(answer.locator('.katex-display')).toHaveCount(1);
    await expect(answer).toHaveAttribute('data-status', 'running');
    await expect(answer).toHaveAttribute('data-status', 'completed');
    await expect(answer.locator('.katex-error')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('assistant-message').last().locator('.katex')).toHaveCount(3);
    expect(errors).toEqual([]);
  } catch (error) {
    await testInfo.attach('math-generation.json', { body: await page.request.get(`/api/conversations/${f.id}`).then((response) => response.body()), contentType: 'application/json' });
    throw error;
  } finally {
    await page.request.put('/api/settings/providers', { headers, data: settings });
    await f.cleanup();
  }
});
