import { expect, test } from '@playwright/test';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('switching language preserves URL, draft, dialog and focus, persists locally and synchronizes tabs', async ({
  page,
  context,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID();
  await page.request.post('/api/conversations', {
    headers,
    data: { id, title: 'Do not translate 你好' },
  });
  try {
    await page.goto(`/c/${id}`);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Keep my draft 原文');
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    const language = page.getByRole('combobox', { name: '语言', exact: true });
    await language.focus();
    let navigations = 0,
      writes = 0;
    page.on('framenavigated', () => navigations++);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
        writes++;
    });
    await language.selectOption('en');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveURL(`/c/${id}`);
    expect(navigations).toBe(0);
    expect(writes).toBe(0);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Keep my draft 原文',
    );
    await expect(
      page.getByRole('link', { name: 'Do not translate 你好', exact: true }),
    ).toBeVisible();
    const other = await context.newPage();
    await other.goto(`/c/${id}`);
    await expect(other.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
    await expect(other.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
    await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(other).toHaveURL(`/c/${id}`);
    await other.close();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.reload();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
      'Keep my draft 原文',
    );
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});

test('system language follows browser changes while an explicit choice stays fixed', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-GB'] });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('system');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('system');
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.evaluate(() => window.dispatchEvent(new Event('languagechange')));
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});

test('lazy settings stay localized at narrow widths without translating configured content', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('everchat:locale', 'en'));
  await page.request.post('/__dev/access/login', { headers });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'AI providers', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Presets', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Add preset', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Web', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Web service', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Web service daily request limit', { exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Usage', exact: true }).click();
  await expect(
    dialog.getByRole('tablist', { name: 'Usage categories', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('tab', { name: 'Pricing', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Configure price', exact: true }).first(),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Close settings', exact: true }),
  ).toBeInViewport();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('anonymous shares localize bubbles and Markdown controls without loading private APIs or losing the secret', async ({
  page,
}) => {
  const id = 'A'.repeat(22),
    secret = 'B'.repeat(43);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.route('**/public/shares/*', (route) =>
    route.fulfill({
      json: {
        share: {
          id,
          title: 'Original 标题',
          createdAt: 1,
          expiresAt: null,
          messageCount: 2,
          omittedAttachments: 0,
          hash: 'x',
        },
        page: {
          cursor: null,
          blocks: [
            {
              message: 0,
              role: 'user',
              channel: 'text',
              text: 'Original 用户内容',
              omittedAttachments: 0,
            },
            {
              message: 1,
              role: 'assistant',
              modelName: 'Model 原名',
              channel: 'reasoning',
              text: 'Original 思考',
              omittedAttachments: 0,
            },
            {
              message: 1,
              role: 'assistant',
              modelName: 'Model 原名',
              channel: 'text',
              text: '```js\nconsole.log("原文")\n```',
              omittedAttachments: 0,
            },
          ],
        },
      },
    }),
  );
  await page.addInitScript(() => localStorage.setItem('everchat:locale', 'en'));
  await page.goto(`/s/${id}#${secret}`);
  await expect(page.getByRole('article', { name: 'Question 1', exact: true })).toContainText(
    'Original 用户内容',
  );
  await expect(page.getByRole('heading', { name: 'Model 原名', exact: true })).toBeVisible();
  await expect(page.getByText('Read-only snapshot · 2 messages', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
  for (const size of [16, 32]) {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = `${value}px`;
    }, size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toBeInViewport();
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '提问 1', exact: true })).toContainText(
    'Original 用户内容',
  );
  await expect(page).toHaveURL(`/s/${id}#${secret}`);
  expect(requests.filter((path) => /^\/(api|auth)(\/|$)/.test(path))).toEqual([]);
  expect(requests.filter((path) => /private-bootstrap|notifications/.test(path))).toEqual([]);
});

test('an existing provider save error is translated when language changes, without resaving the draft', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  await page.goto('/');
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('tab', { name: '供应商', exact: true }).click();
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Unchanged provider 原名');
  await page.getByLabel('API 端点', { exact: true }).fill('http://invalid.example');
  await expect(page.getByTestId('settings-save-status')).toContainText('HTTPS');
  let writes = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/settings') && request.method() !== 'GET')
      writes++;
  });
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.getByTestId('settings-save-status')).toContainText('valid HTTPS API base URL');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unchanged provider 原名');
  await expect(page.getByLabel('API endpoint', { exact: true })).toHaveValue(
    'http://invalid.example',
  );
  expect(writes).toBe(0);
});

test('switching language during a streamed answer preserves its run, draft, URL and content', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const original = await page.request
    .get('/api/settings/providers')
    .then((response) => response.json());
  const providerId = crypto.randomUUID(),
    model = 'benchmark-reasoning-60-150-20';
  let id: string | undefined;
  try {
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            ...original,
            providers: [
              {
                id: providerId,
                name: 'Provider 原名',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [
                  { id: model, name: 'Model 原名', enabled: true, reasoningSupport: 'supported' },
                ],
              },
            ],
            activeProviderId: providerId,
            activeModel: model,
            systemPrompt: '',
            maxOutputTokens: null,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Original question 原文');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const answer = page.getByTestId('assistant-message');
    await expect(answer).toContainText('正文');
    await expect(answer).toHaveAttribute('data-status', 'running');
    const url = page.url();
    id = new URL(url).pathname.split('/')[2];
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Next draft 草稿');
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Next draft 草稿',
    );
    await expect(answer).toHaveAttribute('data-status', 'completed');
    await expect(answer).toContainText('Model 原名');
    const snapshot = await page.request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json());
    expect(snapshot.messages).toHaveLength(2);
    expect(
      snapshot.messages[1].parts.find((part: { type: string }) => part.type === 'text').text,
    ).toContain('正文🙂');
    expect(
      snapshot.messages[1].parts.find((part: { type: string }) => part.type === 'reasoning').text,
    ).toContain('思考🙂');
  } finally {
    if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});
