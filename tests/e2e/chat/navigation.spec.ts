import { expect, test, type APIRequestContext } from '@playwright/test';
import type { LibrarySnapshot } from '../../../shared/conversation/types';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Navigation fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: 'benchmark-text-2-10-32', name: 'Navigation fixture', enabled: true }],
            },
          ],
          activeProviderId: providerId,
          activeModel: 'benchmark-text-2-10-32',
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  return {
    restore: async () => {
      expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
        true,
      );
    },
  };
}
async function conversation(request: APIRequestContext, label: string) {
  const id = crypto.randomUUID(),
    title = `${label} ${id.slice(0, 8)}`;
  expect(
    (await request.post('/api/conversations', { headers, data: { id, title } })).status(),
  ).toBe(201);
  expect(
    (
      await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: { parentId: null, requestId: crypto.randomUUID(), content: title },
      })
    ).status(),
  ).toBe(202);
  await expect
    .poll(
      async () =>
        (
          (await request
            .get(`/api/conversations/${id}`)
            .then((response) => response.json())) as Snapshot
        ).messages[1].status,
    )
    .toBe('completed');
  return { id, title, path: `/c/${id}` };
}

test('SPA navigation, history and refresh restore the correct conversation and its draft', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    const first = await conversation(page.request, 'First'),
      second = await conversation(page.request, 'Second');
    await page.goto('/');
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('新对话草稿');
    await page.evaluate(() => {
      (window as unknown as { spaMarker: string }).spaMarker = 'same-document';
    });
    await page.getByRole('link', { name: first.title, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === first.path);
    await expect(page.getByTestId('user-message')).toContainText(first.title);
    await expect(page.getByRole('link', { name: first.title, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await editor.fill('第一个对话的草稿');
    await page.getByRole('link', { name: second.title, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === second.path);
    await expect(page.getByTestId('user-message')).toContainText(second.title);
    await editor.fill('第二个对话的草稿');
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === first.path);
    await expect(page.getByTestId('user-message')).toContainText(first.title);
    await expect(editor).toHaveValue('第一个对话的草稿');
    await page.goBack();
    await expect(page).toHaveURL('/');
    await expect(editor).toHaveValue('新对话草稿');
    await expect(page.getByTestId('user-message')).toHaveCount(0);
    await page.goForward();
    await page.goForward();
    await expect(page).toHaveURL((url) => url.pathname === second.path);
    await expect(editor).toHaveValue('第二个对话的草稿');
    expect(await page.evaluate(() => (window as unknown as { spaMarker: string }).spaMarker)).toBe(
      'same-document',
    );
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === second.path);
    await expect(page.getByTestId('user-message')).toContainText(second.title);
    await expect(editor).toHaveValue('第二个对话的草稿');
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '今天想聊些什么？', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('user-message')).toHaveCount(0);
  } finally {
    await fixture.restore();
  }
});

test('a direct conversation URL survives login without an existing local selection', async ({
  page,
  context,
}) => {
  const fixture = await setup(page.request);
  try {
    const existing = await conversation(page.request, 'Direct');
    await context.clearCookies();
    await page.goto(existing.path);
    await page.request.post('/__dev/access/login');
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === existing.path);
    await expect(page.getByTestId('user-message')).toContainText(existing.title);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
  } finally {
    await fixture.restore();
  }
});

test('conversation links open in a new tab through native browser navigation', async ({
  page,
  context,
}) => {
  const fixture = await setup(page.request);
  try {
    const existing = await conversation(page.request, 'New tab');
    await page.goto('/');
    const link = page.getByRole('link', { name: existing.title, exact: true });
    await expect(link).toHaveAttribute('href', existing.path);
    const opened = context.waitForEvent('page');
    await link.click({ button: 'middle' });
    const other = await opened;
    await expect(other).toHaveURL((url) => url.pathname === existing.path);
    await expect(other.getByTestId('user-message')).toContainText(existing.title);
    await expect(page).toHaveURL('/');
    await other.close();
  } finally {
    await fixture.restore();
  }
});

for (const invalid of [false, true])
  test(`${invalid ? 'invalid' : 'missing'} conversation URL shows a recoverable error and cannot create a replacement conversation`, async ({
    page,
  }) => {
    const fixture = await setup(page.request);
    try {
      const id = invalid ? 'not-a-conversation-id' : crypto.randomUUID();
      await page.goto(`/c/${id}`);
      await expect(page.getByRole('alert')).toContainText(
        invalid ? '找不到这个页面' : '找不到这个对话',
      );
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('不应创建对话');
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      expect(
        (
          (await page.request
            .get('/api/conversations')
            .then((response) => response.json())) as LibrarySnapshot
        ).conversations.some((item) => item.id === id),
      ).toBe(false);
      await page.locator('aside').getByRole('button', { name: '开启新对话', exact: true }).click();
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
    } finally {
      await fixture.restore();
    }
  });

test('an offline submission receives a URL and survives navigation, acceptance and reload', async ({
  page,
  context,
}) => {
  const fixture = await setup(page.request);
  try {
    await page.goto('/');
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(editor).toBeVisible();
    await context.setOffline(true);
    await editor.fill('离线对话 URL');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}(?:\?branch=[^#]+)?$/);
    const path = new URL(page.url()).pathname;
    await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
    await page.locator('aside').getByRole('button', { name: '开启新对话', exact: true }).click();
    await expect(page).toHaveURL('/');
    await page.getByRole('link', { name: '离线对话 URL', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === path);
    await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === path);
    await expect(page.getByTestId('user-message')).toHaveCount(1);
    await expect(page.getByTestId('user-message')).toContainText('离线对话 URL');
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!)),
    ).toEqual([]);
  } finally {
    await context.setOffline(false);
    await fixture.restore();
  }
});
