import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { EverChatBackup } from '../../../shared/backup/backup';
import type { ConversationSettings } from '../../../shared/conversation/types';
import type { ProviderKind, ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import type { WebToolServiceSettings } from '../../../shared/web-tools/service';
import type { WebToolName } from '../../../shared/web-tools/tasks';
import { chooseChatModel, openSpaceSettings } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin },
  key = 'tvly-browser-private-service-key';
async function setup(
  request: APIRequestContext,
  provider: ProviderKind = 'openai-chat',
  flow = false,
) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const service = (await request
    .get('/api/settings/web-tools')
    .then((r) => r.json())) as WebToolServiceSettings;
  const originalKey = (await request.get('/api/settings/web-tools/key').then((r) => r.json())) as {
    apiKey: string;
  };
  const providerId = crypto.randomUUID(),
    model = `tools-${flow ? 'flow' : 'service'}-${provider}`;
  const config = {
    providers: [
      {
        id: providerId,
        name: '联网测试',
        provider,
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        models: [
          {
            id: model,
            name: '联网模型',
            enabled: true,
            reasoningSupport: 'supported',
            metadataOverrides: { toolCalls: true, contextWindow: 131072 },
          },
          { id: 'unknown-tools-model', name: '未知能力模型', enabled: true },
          {
            id: 'unsupported-tools-model',
            name: '不支持工具的模型',
            enabled: true,
            metadataOverrides: { toolCalls: false },
          },
        ],
      },
    ],
    activeProviderId: providerId,
    activeModel: model,
    systemPrompt: '',
    maxOutputTokens: null,
  };
  expect((await request.put('/api/settings/providers', { headers, data: config })).ok()).toBe(true);
  const saveService = async (apiKey = key, limit = service.usedToday + 40) => {
    expect(
      (
        await request.put('/api/settings/web-tools', {
          headers,
          data: { provider: 'tavily', apiKey, dailyLimit: limit },
        })
      ).ok(),
    ).toBe(true);
  };
  await saveService();
  const ids: string[] = [];
  const snapshot = (id: string) =>
    request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
  const settings = () =>
    request.get('/api/settings/web-tools').then((r) => r.json()) as Promise<WebToolServiceSettings>;
  const runtime = (id: string, taskId: string) =>
    request
      .post(`/api/__test/conversations/${id}/tool-runtime`, { headers, data: { taskId } })
      .then((r) => r.json());
  return {
    ids,
    config,
    providerId,
    model,
    snapshot,
    settings,
    saveService,
    runtime,
    cleanup: async () => {
      expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      expect(
        (
          await request.put('/api/settings/web-tools', {
            headers,
            data: {
              provider: 'tavily',
              apiKey: originalKey.apiKey,
              dailyLimit: service.dailyLimit,
            },
          })
        ).ok(),
      ).toBe(true);
      expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
        true,
      );
    },
  };
}
async function space(page: Page) {
  await openSpaceSettings(page);
  await tab(page, '联网');
}
async function tab(page: Page, name: string) {
  const item = page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('tab', { name, exact: true });
  await item.focus();
  await item.press('Space');
  await expect(item).toHaveAttribute('aria-selected', 'true');
}
async function parameters(page: Page) {
  await expect(page.getByRole('combobox', { name: '聊天模型', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '会话参数', exact: true }).click();
  const modal = page.getByRole('dialog', { name: /^(新对话参数|会话参数)$/ });
  await modal.getByRole('tab', { name: '联网', exact: true }).click();
  return modal;
}
async function enable(page: Page) {
  const toggle = page.getByRole('button', { name: '联网搜索', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function send(page: Page, content = '查询 Cloudflare 文档') {
  await page.getByLabel('消息', { exact: true }).fill(content);
  const response = page.waitForResponse(
    (r) =>
      /\/api\/conversations\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const accepted = await response;
  expect(accepted.status(), await accepted.text()).toBe(202);
  return {
    id: /\/conversations\/([^/]+)\//.exec(accepted.url())![1],
    input: accepted.request().postDataJSON() as {
      requestId: string;
      tools?: WebToolName[];
      settings: ConversationSettings;
    },
  };
}
async function noCachedKey(page: Page) {
  const cached = await page.evaluate(async () => {
    const values: unknown[] = [Object.fromEntries(Object.entries(localStorage))];
    for (const database of await indexedDB.databases()) {
      if (!database.name?.includes('keyval')) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(database.name!);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        for (const store of db.objectStoreNames)
          values.push(
            await new Promise((resolve, reject) => {
              const get = db.transaction(store).objectStore(store).getAll();
              get.onsuccess = () => resolve(get.result);
              get.onerror = () => reject(get.error);
            }),
          );
      } finally {
        db.close();
      }
    }
    return JSON.stringify(values);
  });
  expect(cached).not.toContain(key);
  return cached;
}

test('web settings autosave, validate ceilings, reveal explicitly, hide across tabs and devices, and never cache a service key', async ({
  page,
  context,
  browser,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await space(page);
    const field = page.getByLabel('联网服务 API 密钥', { exact: true });
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('placeholder', '已配置 · 留空保留');
    await page.screenshot({
      path: 'test-results/web-tool-settings-desktop.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '查看联网服务密钥', exact: true }).click();
    await expect(field).toHaveValue(key);
    await expect(field).toHaveAttribute('type', 'text');
    await noCachedKey(page);
    await tab(page, '通用');
    await tab(page, '联网');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('type', 'password');
    const limit = page.getByLabel('联网服务每日请求上限');
    const used = (await f.settings()).usedToday,
      next = used + 50;
    await limit.fill('0');
    await expect(page.getByTestId('web-tool-save-status')).toContainText('1–1,000');
    expect((await f.settings()).dailyLimit).not.toBe(0);
    await limit.fill(String(next));
    await expect(page.getByTestId('web-tool-save-status')).toHaveText('已保存');
    expect((await f.settings()).dailyLimit).toBe(next);
    await page.getByRole('button', { name: '查看联网服务密钥', exact: true }).click();
    await expect(field).toHaveValue(key);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await space(page);
    await expect(field).toHaveValue('');
    const second = await browser.newContext({
      locale: 'zh-CN',
      baseURL: origin,
      storageState: await context.storageState(),
      viewport: { width: 390, height: 700 },
    });
    try {
      const other = await second.newPage();
      await other.goto('/');
      await space(other);
      await expect(other.getByLabel('联网服务每日请求上限')).toHaveValue(String(next));
      await expect(other.getByLabel('联网服务 API 密钥', { exact: true })).toHaveValue('');
      await expect(other.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport();
      expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await other.screenshot({
        path: 'test-results/web-tool-settings-mobile.png',
        animations: 'disabled',
      });
    } finally {
      await second.close();
    }
    await page.getByRole('button', { name: '清除密钥', exact: true }).click();
    await expect(page.getByTestId('web-tool-save-status')).toHaveText('已保存');
    expect((await f.settings()).hasApiKey).toBe(false);
    await field.fill(key);
    await expect(page.getByTestId('web-tool-save-status')).toHaveText('已保存');
    await expect(field).toHaveValue('');
    await noCachedKey(page);
  } finally {
    await page.close();
    await f.cleanup();
  }
});

const combinations: [ProviderKind, WebToolName[]][] = [
  ['openai-chat', ['web_search', 'read_webpage']],
  ['openai-responses', ['web_search', 'read_webpage']],
  ['anthropic', ['web_search', 'read_webpage']],
  ['gemini', ['web_search', 'read_webpage']],
];

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} reasoning interleaves search and fetch, retains source state and supports cross-fragment search after reload`, async ({
    page,
    context,
  }) => {
    const f = await setup(context.request, provider, true);
    try {
      await page.goto('/');
      await enable(page);
      const sent = await send(page, '按顺序检索并核对资料');
      f.ids.push(sent.id);
      const answer = page.getByTestId('assistant-message'),
        reasoning = answer.getByTestId('message-reasoning');
      await expect(reasoning).toHaveAttribute('data-open', '');
      const firstCall = answer.locator('[data-tool-id="call_flow_0_0"]');
      await expect(firstCall).toHaveAttribute('data-tool-state', 'running');
      await firstCall
        .locator(
          ':scope > [data-slot="trace-collapsible"] > [data-slot="trace-collapsible-trigger"]',
        )
        .click();
      await expect(firstCall.locator(':scope > [data-slot="trace-collapsible"]')).toHaveAttribute(
        'data-open',
        '',
      );
      await expect(answer.locator('[data-tool-id="call_flow_1_0"]')).toBeVisible();
      await expect(firstCall.locator(':scope > [data-slot="trace-collapsible"]')).toHaveAttribute(
        'data-open',
        '',
      );
      await expect(answer).toHaveAttribute('data-status', 'completed');
      await expect(reasoning.locator('[data-streamdown="strong"]')).toHaveText([
        '搜索之前🙂',
        '搜索之后🙂',
        '整合结果🙂',
      ]);
      expect(
        await reasoning
          .locator('[data-search-content] > [data-slot="message-scroller-item"] > *')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.textContent)
              .map((node) =>
                node.hasAttribute('data-reasoning-part') ? node.textContent : '工具',
              ),
          ),
      ).toEqual([
        '搜索之前🙂\n第一行\n第二行。',
        '工具',
        '搜索之后🙂\n核对网页。',
        '工具',
        '整合结果🙂\n继续分析。',
      ]);
      await expect(reasoning.locator('[data-reasoning-part="0"] br')).toHaveCount(2);
      const snapshot = await f.snapshot(sent.id);
      expect(snapshot.messages[1].tools!.reasoningBreaks).toEqual([
        { round: 0, reasoningEnd: '**搜索之前🙂**\n第一行\n第二行。'.length },
        {
          round: 1,
          reasoningEnd: ('**搜索之前🙂**\n第一行\n第二行。' + '**搜索之后🙂**\n\n核对网页。')
            .length,
        },
      ]);
      expect((await f.runtime(sent.id, sent.input.requestId)).privatePayloads).toBe(0);
      if (provider === 'openai-chat') {
        await page.screenshot({
          path: 'test-results/reasoning-tools-desktop.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: 'test-results/reasoning-tools-mobile-dark.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 1280, height: 720 });
      }
      await page.reload();
      await expect(answer).toHaveAttribute('data-status', 'completed');
      await reasoning.locator(':scope > [data-slot="trace-collapsible-trigger"]').click();
      await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
      const search = page.getByRole('search', { name: '当前对话搜索', exact: true }),
        input = search.getByLabel('查找当前对话', { exact: true });
      await input.fill('搜索之后🙂');
      await expect(search.getByRole('status')).toContainText('1 / 1');
      await expect(reasoning).toHaveAttribute('data-open', '');
      await input.fill('第二行。 搜索之后🙂');
      await expect(search.getByRole('status')).toContainText('1 / 1');
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...(CSS.highlights.get('everchat-search')?.values() ?? [])].map(String),
          ),
        )
        .toEqual(['第二行。', '搜索之后🙂']);
      await input.fill('Cloudflare');
      await expect(search.getByRole('status')).toContainText('无结果');
    } finally {
      await page.close();
      await f.cleanup();
    }
  });

test('a completed answer retains one visible tool error while collapsed and can reveal and focus its call', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  const id = crypto.randomUUID(),
    taskId = crypto.randomUUID();
  f.ids.push(id);
  try {
    expect(
      (
        await context.request.post('/api/conversations', {
          headers,
          data: { id, title: '失败调用定位' },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await context.request.post(`/api/__test/conversations/${id}/tool-runtime`, {
          headers,
          data: { taskId, fault: 'service-401' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await context.request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: {
            parentId: null,
            requestId: taskId,
            content: '检查失败调用',
            tools: ['web_search'],
          },
        })
      ).status(),
    ).toBe(202);
    await page.goto(`/c/${id}`);
    const answer = page.getByTestId('assistant-message'),
      activity = page.getByTestId('tool-call');
    await expect(answer).toHaveAttribute('data-status', 'completed');
    const reasoning = page.getByTestId('message-reasoning');
    await reasoning.locator(':scope > [data-slot="trace-collapsible-trigger"]').click();
    await expect(reasoning).toHaveAttribute('data-closed', '');
    await expect(activity).toHaveAttribute('data-closed', '');
    await expect(answer.getByRole('alert')).toHaveCount(1);
    const error = answer.getByRole('alert');
    await expect(error).toContainText('联网服务拒绝访问，请检查密钥与权限。');
    await expect(error).toBeVisible();
    await expect(answer.getByText('生成失败', { exact: true })).toHaveCount(0);
    await expect(answer).toContainText('工具回答🙂');
    await answer.getByRole('button', { name: /^查看失败调用/ }).click();
    await expect(reasoning).toHaveAttribute('data-open', '');
    await expect(activity).toHaveAttribute('data-open', '');
    const call = answer.locator('[data-tool-state="failed"]');
    await expect(call).toBeFocused();
    await expect(call).toHaveAttribute(
      'aria-describedby',
      (await error.getAttribute('id')) as string,
    );
    await expect(answer.getByRole('alert')).toHaveCount(1);
    await reasoning.locator(':scope > [data-slot="trace-collapsible-trigger"]').click();
    await expect(error).toBeVisible();
  } finally {
    await page.close();
    await f.cleanup();
  }
});

for (const [provider, tools] of combinations)
  test(`${provider} composer toggle enables search and fetch together and a new conversation returns to off`, async ({
    page,
    context,
  }) => {
    const f = await setup(context.request, provider);
    try {
      await page.goto('/');
      await enable(page);
      const sent = await send(page);
      f.ids.push(sent.id);
      expect(sent.input.tools).toEqual(tools);
      expect(sent.input.settings.tools).toEqual(tools);
      await expect(page.getByTestId('assistant-message')).toHaveAttribute(
        'data-status',
        'completed',
      );
      for (const summary of await page
        .getByTestId('tool-call')
        .locator(':scope > [data-slot="trace-collapsible-trigger"]')
        .all())
        await summary.click();
      await expect(page.getByTestId('tool-activity').getByRole('link')).toHaveCount(tools.length);
      await expect(
        page
          .getByTestId('assistant-message')
          .locator('[data-streamdown="strong"]')
          .filter({ hasText: '工具回答🙂' }),
      ).toBeVisible();
      expect((await f.snapshot(sent.id)).settings!.tools).toEqual(tools);
      const state = await f.runtime(sent.id, sent.input.requestId);
      expect(state.modelCalls).toBe(2);
      expect(state.serviceRequests).toHaveLength(tools.length);
      expect(state.serviceRequests.map((call: { url: string }) => call.url)).toEqual(
        tools.map(
          (name) => `https://api.tavily.com/${name === 'web_search' ? 'search' : 'extract'}`,
        ),
      );
      await page.reload();
      const restored = await parameters(page);
      await expect(restored.getByRole('switch', { name: '联网搜索', exact: true })).toBeChecked();
      await expect(restored.getByRole('switch', { name: '网页读取', exact: true })).toHaveCount(0);
      await restored.getByRole('button', { name: '关闭会话参数', exact: true }).click();
      await page.getByRole('button', { name: '开启新对话', exact: true }).click();
      await expect(page.getByRole('button', { name: '联网搜索', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await noCachedKey(page);
    } finally {
      await page.close();
      await f.cleanup();
    }
  });

test('offline queue pins enabled tools and delivers the same request once after reconnect', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await enable(page);
    await context.setOffline(true);
    await page.getByLabel('消息', { exact: true }).fill('离线排队后读取网页');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+(?:\?branch=[^#]+)?$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    f.ids.push(id);
    const pending = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('everchat:pending') ?? '[]'),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].input.tools).toEqual(['web_search', 'read_webpage']);
    expect(pending[0].input.settings.tools).toEqual(['web_search', 'read_webpage']);
    const taskId = pending[0].input.requestId;
    await context.setOffline(false);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await expect.poll(async () => (await f.runtime(id, taskId)).serviceRequests.length).toBe(2);
    expect((await f.runtime(id, taskId)).modelCalls).toBe(2);
    expect((await f.snapshot(id)).settings!.tools).toEqual(['web_search', 'read_webpage']);
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]').length),
      )
      .toBe(0);
  } finally {
    await context.setOffline(false);
    await page.close();
    await f.cleanup();
  }
});

test('unsupported model or removed credentials preserve the draft and enabled choices before queueing anything', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await enable(page);
    await chooseChatModel(page, JSON.stringify([f.providerId, 'unsupported-tools-model']));
    await page.getByLabel('消息', { exact: true }).fill('模型不支持时保留');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('当前模型不支持工具调用');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('模型不支持时保留');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]')),
    ).toHaveLength(0);
    const modal = await parameters(page);
    await expect(modal.getByRole('switch', { name: '联网搜索', exact: true })).toBeChecked();
    await expect(modal.getByRole('switch', { name: '网页读取', exact: true })).toHaveCount(0);
    await modal.getByRole('button', { name: '关闭会话参数', exact: true }).click();
    await chooseChatModel(page, JSON.stringify([f.providerId, f.model]));
    await f.saveService('');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先配置联网服务');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('模型不支持时保留');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]')),
    ).toHaveLength(0);
    const unchanged = await parameters(page);
    await unchanged.getByRole('switch', { name: '联网搜索', exact: true }).uncheck();
    await unchanged.getByRole('button', { name: '关闭会话参数', exact: true }).click();
    const sent = await send(page, '关闭后正常聊天');
    f.ids.push(sent.id);
    expect(sent.input.tools).toBeUndefined();
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await expect(page.getByTestId('tool-activity')).toHaveCount(0);
    expect((await f.runtime(sent.id, sent.input.requestId)).serviceRequests).toHaveLength(0);
  } finally {
    await page.close();
    await f.cleanup();
  }
});

test('configuring a service from conversation parameters returns to the same dialog with switches available', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await f.saveService('');
    await page.goto('/');
    const modal = await parameters(page);
    await expect(modal.getByRole('switch', { name: '联网搜索', exact: true })).toBeEnabled();
    await modal.getByRole('button', { name: '配置联网服务', exact: true }).click();
    await expect(page.getByRole('tab', { name: '联网', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByLabel('联网服务 API 密钥', { exact: true }).fill(key);
    await expect(page.getByTestId('web-tool-save-status')).toHaveText('已保存');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('switch', { name: '联网搜索', exact: true })).toBeVisible();
    await expect(modal.getByRole('switch', { name: '联网搜索', exact: true })).toBeEnabled();
  } finally {
    await page.close();
    await f.cleanup();
  }
});

test('invalid new-conversation parameters reject attachments before creating a cloud conversation and preserve the draft', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('参数无效时保留附件提问');
    const modal = await parameters(page);
    await modal.getByRole('tab', { name: '上下文', exact: true }).click();
    await modal.getByLabel('上下文 Token 预算', { exact: true }).fill('0');
    await modal.getByRole('button', { name: '关闭会话参数', exact: true }).click();
    await expect(modal).not.toBeVisible();
    let creates = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/conversations')
        creates++;
    });
    await page.getByLabel('选择聊天文件', { exact: true }).setInputFiles({
      name: 'context.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('附加文字资料'),
    });
    await expect(
      page.getByRole('alert').filter({ hasText: '请先修正会话参数，再添加附件。' }),
    ).toBeVisible();
    await expect(page).toHaveURL('/');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('参数无效时保留附件提问');
    expect(creates).toBe(0);
  } finally {
    await page.close();
    await f.cleanup();
  }
});

test('creating a conversation for an attachment preserves its enabled tools and resets the next new conversation', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await enable(page);
    await page.getByLabel('选择聊天文件', { exact: true }).setInputFiles({
      name: 'context.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('附加文字资料'),
    });
    await expect(page).toHaveURL(/\/c\/[^/]+(?:\?branch=[^#]+)?$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    f.ids.push(id);
    await expect
      .poll(async () => (await f.snapshot(id)).settings!.tools)
      .toEqual(['web_search', 'read_webpage']);
    const sent = await send(page);
    expect(sent.id).toBe(id);
    expect(sent.input.tools).toEqual(['web_search', 'read_webpage']);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await page.getByRole('button', { name: '开启新对话', exact: true }).click();
    const fresh = await parameters(page);
    await expect(fresh.getByRole('switch', { name: '联网搜索', exact: true })).not.toBeChecked();
  } finally {
    await page.close();
    await f.cleanup();
  }
});

test('copy and restore retain enabled tools and saved sources without executing a model or search', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await enable(page);
    const sent = await send(page);
    f.ids.push(sent.id);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    const copied = await context.request
      .post(`/api/conversations/${sent.id}/duplicate`, {
        headers,
        data: { requestId: crypto.randomUUID() },
      })
      .then((r) => r.json());
    f.ids.push(copied.id);
    const backup = (await context.request
      .get(`/api/conversations/${sent.id}/backup`)
      .then((r) => r.json())) as EverChatBackup;
    expect(backup.conversation.settings!.tools).toEqual(['web_search', 'read_webpage']);
    expect(JSON.stringify(backup)).not.toContain(key);
    const restored = await context.request
      .post('/api/backup/restore', { headers, data: backup })
      .then((r) => r.json());
    f.ids.push(restored.id);
    for (const id of [copied.id, restored.id]) {
      expect((await f.snapshot(id)).settings!.tools).toEqual(['web_search', 'read_webpage']);
      expect((await f.snapshot(id)).messages[1].tools).toEqual(
        (await f.snapshot(sent.id)).messages[1].tools,
      );
      expect((await f.runtime(id, crypto.randomUUID())).modelCalls).toBe(0);
      expect((await f.runtime(id, crypto.randomUUID())).serviceRequests).toHaveLength(0);
    }
    await page.goto(`/c/${restored.id}`);
    await expect(page.getByTestId('tool-call')).toHaveCount(2);
    for (const summary of await page
      .getByTestId('tool-call')
      .locator(':scope > [data-slot="trace-collapsible-trigger"]')
      .all())
      await summary.click();
    await expect(page.getByTestId('tool-activity').getByRole('link')).toHaveCount(2);
    const modal = await parameters(page);
    await expect(modal.getByRole('switch', { name: '联网搜索', exact: true })).toBeChecked();
    await expect(modal.getByRole('switch', { name: '网页读取', exact: true })).toHaveCount(0);
    await noCachedKey(page);
  } finally {
    await page.close();
    await f.cleanup();
  }
});

test('a late reveal after switching tabs and a late autosave after logout cannot expose or cache credentials', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  let releaseReveal!: () => void,
    reachedReveal!: () => void,
    releaseSave!: () => void,
    reachedSave!: () => void;
  const revealHold = new Promise<void>((resolve) => {
      releaseReveal = resolve;
    }),
    revealReached = new Promise<void>((resolve) => {
      reachedReveal = resolve;
    });
  const saveHold = new Promise<void>((resolve) => {
      releaseSave = resolve;
    }),
    saveReached = new Promise<void>((resolve) => {
      reachedSave = resolve;
    });
  try {
    await page.goto('/');
    await space(page);
    await page.route('**/api/settings/web-tools/key', async (route) => {
      const response = await route.fetch();
      reachedReveal();
      await revealHold;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole('button', { name: '查看联网服务密钥', exact: true }).click();
    await revealReached;
    await tab(page, '通用');
    releaseReveal();
    await tab(page, '联网');
    await expect(page.getByLabel('联网服务 API 密钥', { exact: true })).toHaveValue('');
    await noCachedKey(page);
    await page.unroute('**/api/settings/web-tools/key');
    await page.route('**/api/settings/web-tools', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch();
      reachedSave();
      await saveHold;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByLabel('联网服务 API 密钥', { exact: true }).fill(key);
    await saveReached;
    await tab(page, '通用');
    await page.getByRole('button', { name: '退出并清除本地记录', exact: true }).click();
    await expect(page).toHaveURL(`${headers.Origin}/__dev/access/logout`);
    releaseSave();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((name) => name.startsWith('everchat:web-tool-settings')),
      ),
    ).toEqual([]);
    const cached = await noCachedKey(page);
    expect(cached).not.toContain('"provider":"tavily"');
  } finally {
    releaseReveal();
    releaseSave();
    await page.close();
    await context.request.post('/__dev/access/login', { headers });
    await f.cleanup();
  }
});

test('DeepSeek service selection retains both keys and executes Search and Fetch through the production tool loop', async ({
  page,
  context,
}) => {
  const f = await setup(context.request);
  try {
    await page.goto('/');
    await space(page);
    const choice = page.getByLabel('联网服务', { exact: true });
    const field = page.getByLabel('联网服务 API 密钥', { exact: true });
    await choice.selectOption('deepseek');
    await expect(choice).toBeEnabled();
    await field.fill('deepseek-browser-private-key');
    await expect(page.getByTestId('web-tool-save-status')).toHaveText('已保存');
    expect((await f.settings()).provider).toBe('deepseek');
    await choice.selectOption('tavily');
    await expect(choice).toBeEnabled();
    await page.getByRole('button', { name: '查看联网服务密钥', exact: true }).click();
    await expect(field).toHaveValue(key);
    await choice.selectOption('deepseek');
    await expect(choice).toBeEnabled();
    await expect(field).toHaveValue('');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await enable(page);
    const sent = await send(page);
    f.ids.push(sent.id);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    const state = await f.runtime(sent.id, sent.input.requestId);
    expect(state.serviceRequests.map((call: { url: string }) => call.url)).toEqual([
      'https://api.deepseek.com/v1/tools/search',
      'https://api.deepseek.com/v1/tools/fetch',
    ]);
    expect(state.modelCalls).toBe(2);
    expect(state.privateStreams).toBe(0);
    await noCachedKey(page);
    const cached = await page.evaluate(() =>
      JSON.stringify(Object.fromEntries(Object.entries(localStorage))),
    );
    expect(cached).not.toContain('deepseek-browser-private-key');
  } finally {
    await page.close();
    await f.cleanup();
  }
});
