import { expect, test } from '@playwright/test';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('Mod+J preserves the previous draft, creates no cloud conversation and focuses the new composer', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID();
  await page.request.post('/api/conversations', { headers, data: { id, title: '快捷键草稿' } });
  try {
    await page.goto(`/c/${id}`);
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('原来的草稿');
    let creations = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/conversations')
        creations++;
    });
    await page.keyboard.press('ControlOrMeta+j');
    await expect(page).toHaveURL('/');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('');
    await composer.fill('新的草稿');
    await page.goBack();
    await expect(composer).toHaveValue('原来的草稿');
    await page.keyboard.press('ControlOrMeta+j');
    await expect(composer).toHaveValue('新的草稿');
    expect(creations).toBe(0);
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});

for (const width of [320, 1280])
  test(`Mod+K opens a bounded search popup at ${width}px without consuming drafts or navigating`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.request.post('/__dev/access/login', { headers });
    const id = crypto.randomUUID();
    await page.request.post('/api/conversations', {
      headers,
      data: { id, title: 'Keyboard unique title' },
    });
    try {
      await page.goto(`/c/${id}`);
      const composer = page.getByRole('textbox', { name: '消息', exact: true });
      await composer.fill('保持输入');
      await page.keyboard.press('ControlOrMeta+k');
      const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
      const input = dialog.getByRole('combobox', { name: '搜索对话', exact: true });
      await expect(input).toBeFocused();
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(12);
      expect(box!.y).toBeGreaterThanOrEqual(12);
      expect(box!.width).toBeLessThanOrEqual(Math.min(768, width - 24));
      expect(box!.y + box!.height).toBeLessThanOrEqual(728);
      await expect(page).toHaveURL(`/c/${id}`);
      await input.fill('Keyboard unique');
      await page.keyboard.press('ControlOrMeta+j');
      await expect(page).toHaveURL(`/c/${id}`);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '关闭全局搜索' }).focus();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(input).toBeFocused();
      await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: `/tmp/everchat-global-search-${width}.png` });
      await dialog.getByRole('button', { name: '关闭全局搜索' }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('保持输入');
      // An ordinary settings modal owns its keyboard scope.
      await page.getByRole('button', { name: '更多会话操作' }).click();
      await page.getByRole('menuitem', { name: '快捷键', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toContainText(
        '开启新对话',
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toHaveCount(0);
      await composer.focus();
      const modifiers = await page.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.userAgent) ? { metaKey: true } : { ctrlKey: true },
      );
      for (const ignored of [{ isComposing: true }, { repeat: true }, { altKey: true }]) {
        await composer.dispatchEvent('keydown', { key: 'j', ...modifiers, ...ignored });
        await expect(page).toHaveURL(`/c/${id}`);
      }
    } finally {
      await page.request.delete(`/api/conversations/${id}`, { headers });
    }
  });

test('keyboard selection and native links open the chosen title, while closing mobile search restores the sidebar trigger', async ({
  page,
  context,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID();
  await page.request.post('/api/conversations', {
    headers,
    data: { id, title: 'Title navigation fixture' },
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '全局搜索', exact: true })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('combobox', { name: '搜索对话', exact: true });
    await input.fill('Title navigation fixture');
    await page.screenshot({ path: `/tmp/everchat-global-search.png` });
    const popup = context.waitForEvent('page');
    await page
      .getByRole('link', { name: 'Title navigation fixture', exact: true })
      .click({ modifiers: ['ControlOrMeta'] });
    const other = await popup;
    await other.waitForURL(`/c/${id}`);
    await other.close();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(page).toHaveURL(`/c/${id}`);
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 740 });
    const trigger = page.getByRole('button', { name: '打开对话列表' });
    await trigger.click();
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '对话列表', exact: true })).toHaveCount(0);
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});

test('global search retains loading and retry feedback, avoids empty remote queries and searches all cached titles offline', async ({
  page,
  context,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID(),
    secondId = crypto.randomUUID();
  for (const [key, title] of [
    [id, '本地标题'],
    [secondId, '另一条本地标题'],
  ]) {
    expect(
      (
        await page.request.post('/api/conversations', { headers, data: { id: key, title } })
      ).status(),
    ).toBe(201);
  }
  let release = () => {},
    failing = true,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/conversations?*', async (route) => {
    await gate;
    if (failing)
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'test failure' }),
      });
    else await route.continue();
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/search') calls++;
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
    await expect(dialog.getByRole('status')).toHaveText('正在读取对话列表');
    release();
    await expect(dialog.getByRole('alert')).toContainText('无法更新对话列表');
    failing = false;
    await dialog.getByRole('button', { name: '重试', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('link', { name: '本地标题', exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(calls).toBe(0);
    await context.setOffline(true);
    await dialog.getByRole('combobox').fill('标题');
    await expect(dialog.getByRole('link', { name: '本地标题', exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: '另一条本地标题', exact: true })).toBeVisible();
    await expect(dialog.getByRole('tab')).toHaveCount(0);
    await expect(dialog).toContainText('联网后搜索正文');
    expect(calls).toBe(0);
  } finally {
    release();
    await context.setOffline(false);
    for (const key of [id, secondId])
      await page.request.delete(`/api/conversations/${key}`, { headers });
  }
});

test.describe('Windows shortcut labels and modifiers', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  });
  test('Ctrl+K searches and Ctrl+J creates, while Meta does not intercept the browser', async ({
    page,
  }) => {
    await page.request.post('/__dev/access/login', { headers });
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('Windows draft');
    await expect(page.getByRole('button', { name: '开启新对话', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+J',
    );
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox', { name: '搜索对话' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(composer).toBeFocused();
    await page.keyboard.press('Control+j');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Windows draft');
    const consumed = await composer.evaluate(
      (node) =>
        !node.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    expect(consumed).toBe(false);
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toHaveCount(0);
  });
});

test('body-search retry stays a button action while title results remain selectable', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID();
  await page.request.post('/api/conversations', { headers, data: { id, title: 'Retry fixture' } });
  let attempts = 0;
  await page.route('**/api/search?*', (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? {
            status: 502,
            json: { error: 'body search test failure' },
          }
        : {
            json: {
              results: [
                {
                  conversationId: id,
                  title: 'Retry fixture',
                  messageId: crypto.randomUUID(),
                  field: 'content',
                  excerpt: 'Retry body match',
                },
              ],
              cursor: null,
              indexing: false,
            },
          },
    );
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
    await dialog.getByRole('combobox').fill('Retry');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    const retry = dialog.getByRole('button', { name: '重新搜索', exact: true });
    await expect(retry).toBeVisible();
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('option')).toHaveCount(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL('/');
    await expect(dialog.getByRole('combobox')).toHaveValue('Retry');
    expect(attempts).toBe(2);
  } finally {
    await page.request.delete(`/api/conversations/${id}`, { headers });
  }
});
