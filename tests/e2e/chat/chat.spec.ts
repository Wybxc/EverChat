import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { messageText } from '../../../shared/conversation/content';
import { chooseChatModel, expectChatModel, openSpaceSettings } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174';
async function login(page: Page) {
  await page.goto('/');
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const response = await page.request.put('/api/settings/providers', {
    headers: { Origin: origin },
    data: {
      providers: [
        {
          id: '00000000-0000-4000-8000-000000000099',
          name: 'Integration',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          models: [{ id: 'test-model', name: 'test-model', enabled: true }],
          apiKey: 'integration-test-key',
        },
      ],
      activeProviderId: '00000000-0000-4000-8000-000000000099',
      activeModel: 'test-model',
      systemPrompt: '',
      maxOutputTokens: 128,
    },
  });
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}

test('private API requires authentication and rejects cross-origin writes', async ({
  request,
  page,
}) => {
  expect((await request.get('/api/conversations')).status()).toBe(401);
  expect(
    (
      await request.post('/__dev/access/login', {
        headers: { Origin: 'https://untrusted.invalid' },
      })
    ).status(),
  ).toBe(403);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
  await page
    .context()
    .addCookies([{ name: 'everchat_session', value: 'forged-old-cookie', url: origin }]);
  expect((await page.request.get('/api/session')).status()).toBe(401);
});

test('generation survives offline, tab closure and a second device; retries are idempotent', async ({
  page,
  context,
  browser,
}) => {
  await login(page);
  const prompt = `跨设备测试 ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('消息', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'running');
  const id = new URL(page.url()).pathname.split('/')[2];
  const initial = await context.request
    .get(`/api/conversations/${id}`)
    .then((response) => response.json());
  expect(initial.messages).toHaveLength(2);
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: '你现在离线' })).toContainText('离线');

  const second = await browser.newContext({ locale: 'zh-CN' });
  const otherPage = await second.newPage();
  await login(otherPage);
  await otherPage.getByRole('link', { name: prompt }).click();
  await expect(otherPage.getByTestId('assistant-message')).toHaveAttribute(
    'data-status',
    'completed',
    { timeout: 30_000 },
  );
  await context.setOffline(false);
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('assistant-message')).toContainText('服务端生成完成');
  // Reconnection can expose the plain-text Suspense fallback before the Markdown chunk loads.
  // Wait for both devices to render before capturing the text used for comparison.
  for (const device of [page, otherPage]) {
    await expect(
      device.getByTestId('assistant-message').locator('[data-streamdown="strong"]'),
    ).toHaveText('集成测试回答。');
  }
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    context.request.get(`/api/conversations/${id}`).then((response) => response.json()),
    second.request.get(`/api/conversations/${id}`).then((response) => response.json()),
  ]);
  expect(secondSnapshot).toEqual(firstSnapshot);
  const firstText = (await page.getByTestId('assistant-message').innerText()).replace(/\s+/g, '');
  await expect
    .poll(async () =>
      (await otherPage.getByTestId('assistant-message').innerText()).replace(/\s+/g, ''),
    )
    .toBe(firstText);

  const input = {
    parentId: initial.messages[1].id,
    requestId: randomUUID(),
    content: '关闭页面也继续生成',
  };
  const first = await context.request.post(`/api/conversations/${id}/messages`, {
    headers: { Origin: origin },
    data: input,
  });
  const duplicate = await context.request.post(`/api/conversations/${id}/messages`, {
    headers: { Origin: origin },
    data: input,
  });
  expect(first.status()).toBe(202);
  expect(duplicate.status()).toBe(202);
  expect(await duplicate.json()).toEqual(await first.json());
  const competing = await context.request.post(`/api/conversations/${id}/messages`, {
    headers: { Origin: origin },
    data: { parentId: null, requestId: randomUUID(), content: '不应并发' },
  });
  expect(competing.status()).toBe(409);
  await page.close();
  await otherPage
    .getByRole('status')
    .filter({ hasText: '另一分支已结束' })
    .getByRole('button', { name: '查看', exact: true })
    .click();
  await expect(otherPage.getByTestId('assistant-message').last()).toHaveAttribute(
    'data-status',
    'completed',
    { timeout: 30_000 },
  );
  const final = await second.request
    .get(`/api/conversations/${id}`)
    .then((response) => response.json());
  expect(final.messages).toHaveLength(4);
  expect(messageText(final.messages[3])).toContain('服务端生成完成');
  const settings = await context.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  try {
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers: { Origin: origin },
          data: { ...settings, activeProviderId: null, activeModel: '' },
        })
      ).status(),
    ).toBe(200);
    const replay = await context.request.post(`/api/conversations/${id}/messages`, {
      headers: { Origin: origin },
      data: input,
    });
    expect(replay.status()).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
  } finally {
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers: { Origin: origin },
          data: settings,
        })
      ).status(),
    ).toBe(200);
  }
  await second.close();
});

test('offline outbox is persisted, delivered once, and cancellation preserves progress', async ({
  page,
  context,
}) => {
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
  await expect(page.getByTestId('assistant-message')).toHaveCount(1);
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute(
    'data-status',
    'completed',
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: '上一个回答版本', exact: true }).click();
  await expect(page.getByTestId('assistant-message').first()).toHaveAttribute(
    'data-status',
    'cancelled',
  );
});

test('mobile and desktop layouts fit their viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/login-desktop.png' });
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
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
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await openSpaceSettings(page);
  await page.getByRole('radio', { name: '浅色' }).focus();
  await page.getByRole('radio', { name: '浅色' }).press('Space');
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('system theme follows the operating-system color preference', async ({ page }) => {
  await login(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSpaceSettings(page);
  await page.getByRole('radio', { name: '系统' }).focus();
  await page.getByRole('radio', { name: '系统' }).press('Space');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('the composer uses the selected model and always shows returned provider thoughts', async ({
  page,
  context,
}) => {
  await login(page);
  const settings = await context.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  const model = settings.providers[0].models[0];
  model.reasoningSupport = 'supported';
  settings.providers[0].models.push({
    id: 'test-model-2',
    name: '第二模型',
    enabled: true,
    reasoningSupport: 'supported',
  });
  expect(
    (
      await context.request.put('/api/settings/providers', {
        headers: { Origin: origin },
        data: settings,
      })
    ).status(),
  ).toBe(200);
  const invalidConversationId = randomUUID();
  expect(
    (
      await context.request.post('/api/conversations', {
        headers: { Origin: origin },
        data: { id: invalidConversationId, title: 'Invalid effort' },
      })
    ).status(),
  ).toBe(201);
  const unsupported = await context.request.post(
    `/api/conversations/${invalidConversationId}/messages`,
    {
      headers: { Origin: origin },
      data: {
        parentId: null,
        requestId: randomUUID(),
        content: '不应开始',
        selection: { providerId: settings.providers[0].id, model: 'test-model-2' },
        reasoningEffort: 'max',
      },
    },
  );
  expect(unsupported.status()).toBe(400);
  expect(await unsupported.json()).toMatchObject({ error: '所选模型不支持此思维强度。' });
  await page.reload();
  await chooseChatModel(page, JSON.stringify([settings.providers[0].id, 'test-model-2']));
  await expectChatModel(page, JSON.stringify([settings.providers[0].id, 'test-model-2']));
  await page.getByLabel('思维强度').selectOption('high');
  await page.getByLabel('消息', { exact: true }).fill('用选定模型回答');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const answer = page.getByTestId('assistant-message');
  await expect(answer).toHaveAttribute('data-status', 'running');
  await expect(
    answer
      .getByTestId('message-reasoning')
      .locator('[data-streamdown="strong"]')
      .filter({ hasText: '集成思考。' }),
  ).toBeVisible();
  await expect(
    answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' }),
  ).toBeVisible();
  await expect(answer).toHaveAttribute('data-status', 'running');
  await answer
    .getByTestId('message-reasoning')
    .locator(':scope > [data-slot=trace-collapsible-trigger]')
    .click();
  await expect(answer.getByTestId('message-reasoning')).toHaveAttribute('data-closed', '');
  await expect(answer).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(answer.getByTestId('message-reasoning')).toHaveAttribute('data-closed', '');
  await answer
    .getByTestId('message-reasoning')
    .locator(':scope > [data-slot=trace-collapsible-trigger]')
    .click();
  await expect(answer).toContainText('第二模型：');
  await expect(answer).toContainText('第二模型');
  await expect(answer.getByTestId('message-reasoning')).toContainText('集成思考。');
  await expect(answer.getByTestId('message-reasoning')).toHaveAttribute('data-open', '');
  await expect(
    answer
      .getByTestId('message-reasoning')
      .locator('[data-slot="trace-collapsible-content"] [data-streamdown="strong"]'),
  ).toContainText('集成思考。');
  const id = new URL(page.url()).pathname.split('/')[2];
  const snapshot = await context.request
    .get(`/api/conversations/${id}`)
    .then((response) => response.json());
  expect(snapshot.messages[1]).toMatchObject({
    model: 'test-model-2',
    modelName: '第二模型',
    parts: expect.arrayContaining([{ type: 'reasoning', text: '**集成思考。**' }]),
  });

  await chooseChatModel(page, JSON.stringify([settings.providers[0].id, 'test-model']));
  await answer.getByRole('button', { name: '重新生成' }).click();
  const retry = page.getByTestId('assistant-message').last();
  await expect(retry).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(retry).toContainText('集成测试回答。');
  await expect(retry.getByText('Integration · test-model', { exact: true })).toBeVisible();
  const retried = await context.request
    .get(`/api/conversations/${id}`)
    .then((response) => response.json());
  expect(retried.messages.at(-1)).toMatchObject({ model: 'test-model', modelName: 'test-model' });
});

test('DeepSeek-compatible Responses streams Markdown thoughts, persists them and renders them after reload', async ({
  page,
  context,
}) => {
  await login(page);
  const settings = await context.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  settings.providers[0].provider = 'openai-responses';
  settings.providers[0].models = [{ id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true }];
  settings.activeModel = 'deepseek-flash';
  expect(
    (
      await context.request.put('/api/settings/providers', {
        headers: { Origin: origin },
        data: settings,
      })
    ).status(),
  ).toBe(200);
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
  await expect(
    answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' }),
  ).toHaveCount(0);
  await thoughts.locator(':scope > [data-slot=trace-collapsible-trigger]').click();
  await expect(thoughts).toHaveAttribute('data-closed', '');
  await expect(
    answer.locator('[data-streamdown="strong"]').filter({ hasText: '集成测试回答。' }),
  ).toBeVisible();
  await expect(answer).toHaveAttribute('data-status', 'running');
  await expect(answer).toHaveAttribute('data-status', 'completed');
  await expect(thoughts).toHaveAttribute('data-closed', '');
  const id = new URL(page.url()).pathname.split('/')[2];
  const snapshot = await context.request
    .get(`/api/conversations/${id}`)
    .then((response) => response.json());
  expect(snapshot.messages[1]).toMatchObject({
    model: 'deepseek-flash',
    parts: expect.arrayContaining([{ type: 'reasoning', text: '**集成思考。**' }]),
  });
  await page.reload();
  await expect(thoughts.locator('[data-streamdown="strong"]')).toBeVisible();
  await thoughts.getByText('思考过程', { exact: true }).click();
  await expect(thoughts.locator('[data-streamdown="strong"]')).not.toBeVisible();
  await thoughts.getByText('思考过程', { exact: true }).click();
  await expect(thoughts.locator('[data-streamdown="strong"]')).toBeVisible();
});

async function startScrollTest(page: Page, model = 'scroll-test') {
  await page.setViewportSize({ width: 900, height: 700 });
  await login(page);
  const settings = await page.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  settings.providers[0].models = [{ id: model, name: '滚动测试', enabled: true }];
  settings.activeModel = model;
  expect(
    (
      await page.request.put('/api/settings/providers', {
        headers: { Origin: origin },
        data: settings,
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await page.getByLabel('消息', { exact: true }).fill('持续生成，验证滚动');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const answer = page.getByTestId('assistant-message');
  const conversation = page.getByTestId('message-viewport');
  const thoughts = answer.getByTestId('message-reasoning').locator('.overflow-y-auto');
  return { answer, conversation, thoughts };
}

const metrics = (pane: Locator) =>
  pane.evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    gap: node.scrollHeight - node.scrollTop - node.clientHeight,
    overflow: node.scrollHeight - node.clientHeight,
  }));

test('streaming answers and thoughts follow the bottom, pause when scrolled up and resume at the bottom', async ({
  page,
}) => {
  const { answer, conversation, thoughts } = await startScrollTest(page);
  await expect.poll(async () => (await metrics(conversation)).overflow).toBeGreaterThan(400);
  await expect.poll(async () => (await metrics(thoughts)).overflow).toBeGreaterThan(300);
  const initial = await metrics(conversation);
  const initialThoughts = await metrics(thoughts);
  await expect
    .poll(async () => (await metrics(conversation)).height)
    .toBeGreaterThan(initial.height + 100);
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);
  await expect
    .poll(async () => (await metrics(thoughts)).height)
    .toBeGreaterThan(initialThoughts.height + 100);
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  await expect(answer).toHaveAttribute('data-status', 'running');

  await conversation.evaluate((node) => {
    node.scrollTop -= 250;
  });
  await expect(page.getByRole('button', { name: '跳到底部' })).toBeVisible();
  const reading = await metrics(conversation);
  await expect
    .poll(async () => (await metrics(conversation)).height)
    .toBeGreaterThan(reading.height + 100);
  expect((await metrics(conversation)).top).toBeCloseTo(reading.top, 0);
  await page.getByRole('button', { name: '跳到底部' }).click();
  const resumed = await metrics(conversation);
  await expect
    .poll(async () => (await metrics(conversation)).height)
    .toBeGreaterThan(resumed.height + 100);
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);

  await thoughts.evaluate((node) => {
    node.scrollTop -= 250;
  });
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeGreaterThan(100);
  const readingThoughts = await metrics(thoughts);
  await expect
    .poll(async () => (await metrics(thoughts)).height)
    .toBeGreaterThan(readingThoughts.height + 100);
  expect((await metrics(thoughts)).top).toBeCloseTo(readingThoughts.top, 0);
  await thoughts.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  const resumedThoughts = await metrics(thoughts);
  await expect
    .poll(async () => (await metrics(thoughts)).height)
    .toBeGreaterThan(resumedThoughts.height + 100);
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  await expect(answer).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);
  await expect.poll(async () => (await metrics(thoughts)).gap).toBeLessThan(2);
  await conversation.evaluate((node) => {
    node.scrollTop -= 250;
  });
  await expect(page.getByRole('button', { name: '跳到底部' })).toBeVisible();
  await page.getByRole('button', { name: '打开对话列表' }).click();
  await page.getByRole('button', { name: '开启新对话' }).click();
  await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
  await expect(page.getByRole('button', { name: '跳到底部' })).toHaveCount(0);
});

for (const outcome of ['completed', 'cancelled', 'interrupted'] as const) {
  test(`streaming answers preserve both reading positions when ${outcome}`, async ({ page }) => {
    const status = outcome === 'interrupted' ? 'completed' : outcome;
    const { answer, conversation, thoughts } = await startScrollTest(
      page,
      outcome === 'interrupted' ? 'scroll-test-error' : 'scroll-test',
    );
    await expect.poll(async () => (await metrics(conversation)).overflow).toBeGreaterThan(700);
    await expect.poll(async () => (await metrics(thoughts)).overflow).toBeGreaterThan(700);
    for (const pane of [thoughts, conversation]) {
      await pane.evaluate((node) => {
        node.scrollTop -= 250;
      });
      await expect.poll(async () => (await metrics(pane)).gap).toBeGreaterThan(100);
    }
    const reading = await metrics(conversation),
      readingThoughts = await metrics(thoughts);
    await expect
      .poll(async () => (await metrics(conversation)).height)
      .toBeGreaterThan(reading.height + 50);
    await expect
      .poll(async () => (await metrics(thoughts)).height)
      .toBeGreaterThan(readingThoughts.height + 50);
    expect((await metrics(conversation)).top).toBeCloseTo(reading.top, 0);
    expect((await metrics(thoughts)).top).toBeCloseTo(readingThoughts.top, 0);
    await expect(answer).toHaveAttribute('data-status', 'running');
    if (status === 'cancelled') await page.getByRole('button', { name: '停止生成' }).click();
    await expect(answer).toHaveAttribute('data-status', status, { timeout: 30_000 });
    if (outcome === 'interrupted')
      await expect(answer.getByTestId('provider-failure')).toBeVisible();
    await expect.poll(async () => (await metrics(conversation)).top).toBeCloseTo(reading.top, 0);
    await expect
      .poll(async () => (await metrics(thoughts)).top)
      .toBeCloseTo(readingThoughts.top, 0);
  });
}

test('selecting streamed text pauses following until the reader explicitly returns to the bottom', async ({
  page,
}) => {
  const { answer, conversation } = await startScrollTest(page);
  await expect.poll(async () => (await metrics(conversation)).overflow).toBeGreaterThan(500);
  await answer
    .locator('[data-search-content$=":content"] p')
    .last()
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString().length ?? 0))
    .toBeGreaterThan(0);
  await conversation.evaluate(async () => {
    await new Promise(requestAnimationFrame);
  });
  const reading = await metrics(conversation);
  await expect
    .poll(async () => (await metrics(conversation)).height)
    .toBeGreaterThan(reading.height + 100);
  expect((await metrics(conversation)).top).toBeCloseTo(reading.top, 0);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.getByRole('button', { name: '跳到底部', exact: true }).click();
  await expect.poll(async () => (await metrics(conversation)).gap).toBeLessThan(2);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
});
