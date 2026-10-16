import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext, streaming = false) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  if (streaming) {
    const providerId = crypto.randomUUID();
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: 'Search fixture',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [{ id: 'scroll-test', name: 'Search fixture', enabled: true }],
              },
            ],
            activeProviderId: providerId,
            activeModel: 'scroll-test',
            showReasoning: true,
            systemPrompt: '',
            maxOutputTokens: null,
          },
        })
      ).ok(),
    ).toBe(true);
  }
  const id = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: '正文搜索测试' } })
    ).status(),
  ).toBe(201);
  const seed = await request.post(`/api/__test/conversations/${id}/search-history`, {
    headers,
    data: {},
  });
  expect(seed.ok()).toBe(true);
  return {
    id,
    ...((await seed.json()) as { user: string; assistant: string; last: string }),
    cleanup: async () => {
      expect((await request.delete(`/api/conversations/${id}`, { headers })).ok()).toBe(true);
      if (streaming)
        expect(
          (await request.put('/api/settings/providers', { headers, data: original })).ok(),
        ).toBe(true);
    },
  };
}
const toolbar = (page: Page) => page.getByRole('search', { name: '当前对话搜索', exact: true });
const input = (page: Page) =>
  toolbar(page).getByRole('textbox', { name: '查找当前对话', exact: true });
const status = (page: Page) => toolbar(page).getByRole('status');
const highlighted = (page: Page) =>
  page.evaluate(() => String(CSS.highlights.get('everchat-search')?.values().next().value ?? ''));
const pane = (page: Page) => page.getByRole('region', { name: '对话消息' }).locator('..');
const metrics = (page: Page) =>
  pane(page).evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    gap: node.scrollHeight - node.scrollTop - node.clientHeight,
  }));

test('unavailable Markdown runtimes preserve messages and drafts, then recover on reconnect', async ({
  page,
  context,
}) => {
  const fixture = await setup(page.request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const runtime = '**/deps/streamdown.js*';
  const plugins = '**/deps/@streamdown_*.js*';
  await page.route(runtime, (route) => route.abort());
  await page.route(plugins, (route) => route.abort());
  try {
    await page.goto(`/c/${fixture.id}`);
    const answer = page.getByTestId('assistant-message').first();
    await expect(answer).toContainText('const TARGET = 1;');
    await expect(answer.locator('[data-search-content$=":content"]')).toContainText('**格式**');
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('保留我的离线草稿');
    await context.setOffline(true);
    await expect(page.getByRole('banner')).toContainText('离线');
    await page.unroute(runtime);
    await page.unroute(plugins);
    await context.setOffline(false);
    await expect(page.locator('.katex')).toHaveCount(1);
    await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
    await expect(answer.locator('[data-streamdown="strong"]')).toContainText('格式');
    await expect(composer).toHaveValue('保留我的离线草稿');
    expect(errors).toEqual([]);
  } finally {
    await context.setOffline(false);
    await fixture.cleanup();
  }
});

for (const chunk of ['mermaid', 'highlighted-body'])
  test(`a failed internal ${chunk} chunk preserves the page, search and draft until rendering is reloaded`, async ({
    page,
    context,
  }) => {
    const fixture = await setup(page.request),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const runtime = `**/deps/${chunk}-*.js*`;
    await page.route(runtime, (route) => route.abort());
    try {
      await page.goto(`/c/${fixture.id}`);
      const fallback = page.getByTestId('markdown-fallback');
      await expect(fallback).toContainText('跨越 **格式** 搜索。');
      const composer = page.getByLabel('消息', { exact: true });
      await composer.fill('模块加载失败时保留的草稿');
      await context.setOffline(true);
      await expect(fallback.getByRole('button', { name: '重新加载' })).toBeDisabled();
      await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
      await input(page).fill('target');
      await expect(status(page)).toContainText('1 / 5');
      await page.unroute(runtime);
      await context.setOffline(false);
      await expect(fallback.getByRole('button', { name: '重新加载' })).toBeEnabled();
      await fallback.getByRole('button', { name: '重新加载' }).click();
      await expect(page.getByTestId('markdown-fallback')).toHaveCount(0);
      await expect(
        page.getByTestId('assistant-message').first().locator('pre.language-js'),
      ).toContainText('const TARGET = 1;');
      await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
      await expect(composer).toHaveValue('模块加载失败时保留的草稿');
      expect(errors).toEqual([]);
    } finally {
      await context.setOffline(false);
      await fixture.cleanup();
    }
  });

test('search finds rendered Markdown and literal text, navigates occurrences, excludes controls, and restores focus', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    await page.goto(`/c/${fixture.id}`);
    await expect(page.locator('.katex')).toHaveCount(1);
    await expect(page.locator('[data-streamdown="mermaid"]')).toHaveCount(1);
    await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
    expect(
      await page.locator('pre code span').filter({ hasText: 'TARGET' }).count(),
    ).toBeGreaterThan(0);
    await expect(page.locator('[data-streamdown="code-block-copy-button"]')).toHaveCount(1);
    const trigger = page.getByRole('button', { name: '搜索当前对话', exact: true });
    await trigger.click();
    await expect(input(page)).toBeFocused();
    await input(page).fill('target');
    await expect(status(page)).toContainText('1 / 5');
    await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await input(page).dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    await expect(status(page)).toContainText('1 / 5');
    await expect(page.locator('[data-search-current]')).toHaveAttribute(
      'data-message-id',
      fixture.user,
    );
    expect(await highlighted(page)).toBe('TARGET');
    await input(page).press('Enter');
    await expect(status(page)).toContainText('2 / 5');
    await expect(page.locator('[data-search-current]')).toHaveAttribute(
      'data-message-id',
      fixture.assistant,
    );
    await input(page).press('Shift+Enter');
    await expect(status(page)).toContainText('1 / 5');
    await toolbar(page).getByRole('button', { name: '上一个匹配' }).click();
    await expect(status(page)).toContainText('5 / 5');
    await expect(page.locator('[data-search-current]')).toHaveAttribute(
      'data-message-id',
      fixture.last,
    );
    await toolbar(page).getByRole('button', { name: '下一个匹配' }).click();
    await expect(status(page)).toContainText('1 / 5');

    await input(page).fill('跨越 格式 搜索');
    await expect(status(page)).toContainText('1 / 1');
    expect(await highlighted(page)).toBe('跨越 格式 搜索');
    await input(page).fill('[a+b]');
    await expect(status(page)).toContainText('1 / 2');
    await toolbar(page).getByRole('button', { name: '下一个匹配' }).click();
    await expect(status(page)).toContainText('2 / 2');
    expect(await highlighted(page)).toBe('[a+b]');
    await input(page).fill('复制');
    await expect(status(page)).toContainText('无结果');
    await expect(toolbar(page).getByRole('button', { name: '下一个匹配' })).toBeDisabled();
    expect(await highlighted(page)).toBe('');
    await input(page).fill('TARGET 模型名');
    await expect(status(page)).toContainText('无结果');
    await input(page).fill('😀 中文');
    await expect(status(page)).toContainText('1 / 1');
    expect(await highlighted(page)).toBe('😀 中文');
    await input(page).press('Escape');
    await expect(toolbar(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await highlighted(page)).toBe('');
    await expect(page.locator('[data-search-current]')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test('search reveals collapsed thoughts and locates matches in both nested and outer scroll panes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 650 });
  const fixture = await setup(page.request);
  try {
    await page.goto(`/c/${fixture.id}`);
    const details = page.getByTestId('message-reasoning');
    await details.locator('summary').click();
    await expect(details).not.toHaveAttribute('open');
    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await input(page).fill('隐藏目标');
    await expect(status(page)).toContainText('1 / 1');
    await expect(details).toHaveAttribute('open');
    const nested = details.locator('.overflow-y-auto');
    await expect.poll(() => nested.evaluate((node) => node.scrollTop)).toBeLessThan(5);
    await expect
      .poll(() =>
        details.locator('summary').evaluate((node) => {
          const parent = node.closest('section')!.parentElement!.getBoundingClientRect();
          return node.getBoundingClientRect().top >= parent.top;
        }),
      )
      .toBe(true);
    await input(page).fill('思考终点');
    await expect(status(page)).toContainText('1 / 1');
    await expect
      .poll(() => nested.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
      .toBeLessThan(5);
    expect(await highlighted(page)).toBe('思考终点');
  } finally {
    await fixture.cleanup();
  }
});

test('cached search works offline on mobile, resets on navigation and clears when the conversation is deleted', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const fixture = await setup(page.request);
  try {
    await page.goto(`/c/${fixture.id}`);
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
    // Development has no Service Worker; finish loading the lazily rendered code block before disconnecting.
    await expect(
      page.getByTestId('assistant-message').first().locator('pre.language-js'),
    ).toContainText('const TARGET = 1;');
    await context.setOffline(true);
    await page.keyboard.press('ControlOrMeta+f');
    await expect(input(page)).toBeFocused();
    await input(page).fill('target');
    await expect(status(page)).toContainText('1 / 5');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '关闭对话搜索' }).click();
    await page.getByRole('button', { name: '打开对话列表' }).click();
    await page
      .getByRole('dialog', { name: '对话列表' })
      .getByRole('button', { name: '开启新对话' })
      .click();
    await expect(page).toHaveURL('/');
    expect(await highlighted(page)).toBe('');
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === `/c/${fixture.id}`);
    await expect(toolbar(page)).toHaveCount(0);
    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await expect(input(page)).toHaveValue('');
    await context.setOffline(false);
    await input(page).fill('target');
    await expect(status(page)).toContainText('1 / 5');
    expect((await page.request.delete(`/api/conversations/${fixture.id}`, { headers })).ok()).toBe(
      true,
    );
    await expect(page.getByRole('alert')).toContainText('这个对话已删除');
    await expect(toolbar(page)).toHaveCount(0);
    expect(await highlighted(page)).toBe('');
  } finally {
    await context.setOffline(false);
    await fixture.cleanup();
  }
});

test('streaming search updates its count while retaining the active occurrence and the reading position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 650 });
  const fixture = await setup(page.request, true);
  try {
    await page.goto(`/c/${fixture.id}`);
    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await input(page).fill('target');
    await expect(status(page)).toContainText('1 / 5');
    const reading = await metrics(page);
    const response = await page.request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: {
        parentId: fixture.last,
        requestId: crypto.randomUUID(),
        content: '持续输出以验证搜索',
        showReasoning: true,
      },
    });
    expect(response.status()).toBe(202);
    const { runId } = await response.json();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect
      .poll(async () => (await metrics(page)).height)
      .toBeGreaterThan(reading.height + 100);
    expect((await metrics(page)).top).toBeCloseTo(reading.top, 0);
    await expect(status(page)).toContainText('1 / 5');
    expect(await highlighted(page)).toBe('TARGET');
    await input(page).fill('持续生成的内容');
    await expect(status(page)).toContainText('第 1 个匹配');
    await expect.poll(() => highlighted(page)).toBe('持续生成的内容');
    const before = await status(page).textContent();
    await expect.poll(() => status(page).textContent()).not.toBe(before);
    expect(await highlighted(page)).toBe('持续生成的内容');
    expect(
      (
        await page.request.post(`/api/conversations/${fixture.id}/cancel`, {
          headers,
          data: { runId },
        })
      ).ok(),
    ).toBe(true);
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute(
      'data-status',
      'cancelled',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('returning to the bottom resumes following when content grows before the scroll event is delivered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 650 });
  const fixture = await setup(page.request);
  try {
    await page.goto(`/c/${fixture.id}`);
    const thoughts = page.getByTestId('message-reasoning').locator('.overflow-y-auto');
    await thoughts.hover();
    await page.mouse.wheel(0, -250);
    await expect
      .poll(() =>
        thoughts.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
      )
      .toBeGreaterThan(100);
    await thoughts.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    // A new chunk can change layout in the same frame as the user's return to the old bottom.
    await thoughts.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      (node.firstElementChild as HTMLElement).style.paddingBottom = '120px';
    });
    await expect
      .poll(
        () => thoughts.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
        { timeout: 2000 },
      )
      .toBeLessThan(2);
  } finally {
    await fixture.cleanup();
  }
});
