import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { messageText } from '../../../shared/conversation/content';
import { openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function fixture(page: Page) {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  await page.request.put('/api/settings/providers', {
    headers,
    data: {
      ...original,
      activeProviderId: providerId,
      activeModel: 'test-model',
      providers: [
        {
          id: providerId,
          name: 'UI Test',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [
            {
              id: 'test-model',
              name: 'EverChat Test',
              enabled: true,
              reasoningSupport: 'supported',
            },
            {
              id: 'test-model-2',
              name: 'Thinking Test',
              enabled: true,
              reasoningSupport: 'supported',
            },
          ],
        },
      ],
    },
  });
  return {
    providerId,
    cleanup: async () => {
      await page.request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('centered new chat keeps its composer, draft and focus when sending and navigating', async ({
  page,
}, info) => {
  const data = await fixture(page);
  let id = '';
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const composer = page.getByTestId('chat-composer'),
      input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(page.getByRole('heading', { name: '今天想聊些什么？' })).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.width).toBeCloseTo(776);
    expect(box.y).toBeGreaterThan(200);
    expect(box.y + box.height).toBeLessThan(650);
    await input.evaluate((element) => {
      (window as unknown as { migrationEditor: Element }).migrationEditor = element;
    });
    for (const mode of ['浅色', '深色']) {
      await openSpaceSettings(page);
      await page.getByRole('tab', { name: '通用', exact: true }).click();
      await page.getByRole('radio', { name: mode, exact: true }).focus();
      await page.getByRole('radio', { name: mode, exact: true }).press('Space');
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`new-chat-${mode === '浅色' ? 'light' : 'dark'}.png`),
      });
    }
    await input.fill('界面迁移验证');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[a-f0-9-]+(?:\?branch=[^#]+)?$/);
    id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    expect(
      await input.evaluate(
        (element) =>
          element === (window as unknown as { migrationEditor: Element }).migrationEditor,
      ),
    ).toBe(true);
    await expect(input).toBeFocused();
    expect((await composer.boundingBox())!.y).toBeGreaterThan(650);
    await page.screenshot({ path: info.outputPath('conversation-dark.png') });
    await input.fill('保留下一条草稿');
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await expect(input).toHaveValue('保留下一条草稿');
    await page.getByRole('button', { name: '打开对话列表' }).click();
    await expect(page.getByRole('button', { name: '空间设置' })).toBeVisible();
    await page.getByRole('button', { name: '开启新对话' }).click();
    await expect(input).toBeFocused();
    expect(
      await input.evaluate(
        (element) =>
          element === (window as unknown as { migrationEditor: Element }).migrationEditor,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(input).toHaveValue('保留下一条草稿');
  } finally {
    if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
    await data.cleanup();
  }
});

test('desktop Enter sends, Shift+Enter inserts a newline, and IME confirmation never sends', async ({
  page,
}) => {
  const data = await fixture(page);
  let id = '';
  try {
    // A narrow desktop window still uses desktop keyboard behavior.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(input).toHaveAttribute('enterkeyhint', 'send');
    await input.fill('第一行第二行');
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent('keydown', { key: 'Enter', ...composition });
      await expect(input).toHaveValue('第一行第二行');
      await expect(page.getByTestId('user-message')).toHaveCount(0);
    }
    await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 3));
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('第一行\n第二行');
    await expect(page.getByTestId('user-message')).toHaveCount(0);
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(request.url()),
    );
    await input.press('Enter');
    const request = await sent;
    id = new URL(request.url()).pathname.split('/')[3];
    expect(request.postDataJSON().content).toBe('第一行\n第二行');
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await expect(input).toHaveValue('');
  } finally {
    if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
    await data.cleanup();
  }
});

test.describe('touch composer', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test('Return inserts native newlines at the caret and only the send button submits', async ({
    page,
  }) => {
    const data = await fixture(page);
    let id = '';
    try {
      await page.goto('/');
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await expect(input).toHaveAttribute('enterkeyhint', 'enter');
      await input.tap();
      await input.fill('第一行第二行');
      await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 3));
      await input.press('Enter');
      await expect(input).toHaveValue('第一行\n第二行');
      await input.press('Enter');
      await expect(input).toHaveValue('第一行\n\n第二行');
      await expect(page.getByTestId('user-message')).toHaveCount(0);
      await expect(input).toBeFocused();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(input).toHaveAttribute('enterkeyhint', 'enter');
      await input.press('Enter');
      await expect(input).toHaveValue('第一行\n\n\n第二行');
      await expect(page.getByTestId('user-message')).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      const sent = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          /\/api\/conversations\/[^/]+\/messages$/.test(request.url()),
      );
      await page.getByRole('button', { name: '发送消息', exact: true }).tap();
      const request = await sent;
      id = new URL(request.url()).pathname.split('/')[3];
      expect(request.postDataJSON().content).toBe('第一行\n\n\n第二行');
      await expect(page.getByTestId('assistant-message')).toHaveAttribute(
        'data-status',
        'completed',
      );
      await expect(input).toHaveValue('');
    } finally {
      if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
      await data.cleanup();
    }
  });
});

test('prompt history recalls the visible branch only and stays locked after any edit until cleared', async ({
  page,
}) => {
  const data = await fixture(page);
  let id = '';
  try {
    await page.goto('/');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    for (const [index, text] of ['历史问题一', '历史问题二\n第二行'].entries()) {
      await input.fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.getByTestId('assistant-message').nth(index)).toHaveAttribute(
        'data-status',
        'completed',
      );
    }
    id = new URL(page.url()).pathname.split('/').at(-1)!;
    const snapshot = async () =>
      (await page.request
        .get(`/api/conversations/${id}`)
        .then((response) => response.json())) as Snapshot;
    const original = await snapshot();
    await expect(input).toHaveValue('');
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent('keydown', { key: 'ArrowUp', ...composition });
      await expect(input).toHaveValue('');
    }
    await input.press('ArrowDown');
    await expect(input).toHaveValue('');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('历史问题二\n第二行');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('历史问题一');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('历史问题一');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('历史问题二\n第二行');
    // Even reverting an edit to the recalled text must not re-enable navigation.
    await input.press('End');
    await input.press('x');
    await input.press('Backspace');
    await input.press('ArrowUp');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('历史问题二\n第二行');
    await input.fill('');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('历史问题二\n第二行');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('');
    await input.fill('未发送草稿\n仍在编辑');
    await input.press('ArrowUp');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('未发送草稿\n仍在编辑');
    await input.fill('');
    await page.goto(`/c/${id}?branch=${original.messages[1].id}`);
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await input.press('ArrowUp');
    await expect(input).toHaveValue('历史问题一');
    await page.goto('/');
    await expect(input).toHaveValue('');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('');
    expect((await snapshot()).messages.map((message) => messageText(message))).toEqual(
      original.messages.map((message) => messageText(message)),
    );
  } finally {
    if (id) await page.request.delete(`/api/conversations/${id}`, { headers });
    await data.cleanup();
  }
});
