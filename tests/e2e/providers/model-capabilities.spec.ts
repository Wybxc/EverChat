import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ProviderSettings } from '../../../shared/providers/types';
import type { SessionInfo } from '../../../shared/auth/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { editModel, openParameters, openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
const getSettings = (request: APIRequestContext) =>
  request.get('/api/settings/providers').then((r) => r.json()) as Promise<ProviderSettings>;
const publicCatalog = {
  openai: {
    models: {
      'directory-browser-fixture': {
        tool_call: true,
        reasoning: true,
        structured_output: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 131072, output: 16384 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
};
async function setup(request: APIRequestContext, id = 'probe-good', modelPatch = {}) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = await getSettings(request),
    providerId = crypto.randomUUID();
  const configuration = {
    providers: [
      {
        id: providerId,
        name: 'Capability fixture',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        models: [{ id, name: 'My model', enabled: true, ...modelPatch }],
      },
    ],
    activeProviderId: providerId,
    activeModel: id,
    systemPrompt: 'Keep global prompt',
    maxOutputTokens: null,
  };
  expect(
    (await request.put('/api/settings/providers', { headers, data: configuration })).status(),
  ).toBe(200);
  return {
    original,
    providerId,
    configuration,
    restore: () => request.put('/api/settings/providers', { headers, data: original }),
  };
}
async function openProvider(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  await openSpaceSettings(page);
  await page.getByRole('tab', { name: '供应商', exact: true }).press('Space');
  await editModel(page);
}
async function saved(page: Page) {
  await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
}
test.beforeEach(async ({ page }) => {
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({ json: publicCatalog }),
  );
});

test('public catalog enrichment preserves manual values and drafts, persists across devices, and reuses its seven-day cache', async ({
  page,
  context,
  browser,
}) => {
  const f = await setup(context.request, 'directory-browser-fixture', {
    metadataOverrides: { imageInput: false },
  });
  let downloads = 0;
  await page.route('https://models.dev/api.json', async (route) => {
    downloads++;
    await route.fulfill({ json: publicCatalog });
  });
  try {
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('保留聊天草稿');
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: '供应商', exact: true }).press('Space');
    await editModel(page);
    await saved(page);
    await expect(page.getByLabel('上下文窗口（Tokens） 1')).toHaveAttribute(
      'placeholder',
      '131072',
    );
    await expect(page.getByLabel('图片输入 1')).toHaveValue('unsupported');
    await expect(page.getByText('模型目录', { exact: true }).first()).toBeVisible();
    const enriched = await getSettings(context.request),
      model = enriched.providers[0].models[0];
    expect(model).toMatchObject({
      name: 'My model',
      enabled: true,
      metadataOverrides: { imageInput: false },
      directoryMetadata: {
        match: 'exact',
        values: { contextWindow: 131072, imageInput: true, toolCalls: true },
      },
    });
    expect(enriched.providers[0].apiKey).toBe('integration-test-key');
    expect(enriched.systemPrompt).toBe('Keep global prompt');
    const session = (await context.request
      .get('/api/session')
      .then((r) => r.json())) as SessionInfo;
    expect(session.models![0].metadata).toMatchObject({
      imageInput: false,
      sources: { imageInput: 'manual', toolCalls: 'directory' },
    });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留聊天草稿');
    await openProvider(page);
    await saved(page);
    expect(downloads).toBe(1);
    const other = await browser.newContext({
      locale: 'zh-CN',
      baseURL: 'http://127.0.0.1:5174',
      storageState: await context.storageState(),
    });
    try {
      await other.route('https://models.dev/api.json', (route) => route.abort());
      const second = await other.newPage();
      await openProvider(second);
      await expect(second.getByLabel('上下文窗口（Tokens） 1')).toHaveAttribute(
        'placeholder',
        '131072',
      );
      await expect(second.getByLabel('图片输入 1')).toHaveValue('unsupported');
    } finally {
      await other.close();
    }
  } finally {
    await page.close();
    expect((await f.restore()).status()).toBe(200);
  }
});

test('explicit model tests verify output, save only positive evidence and preserve manual overrides through backup restore', async ({
  page,
  context,
}) => {
  const f = await setup(context.request, 'probe-good', { metadataOverrides: { toolCalls: false } });
  const conversations: string[] = [],
    capabilities: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/models/test'))
      capabilities.push(request.postDataJSON().capability);
  });
  try {
    await openProvider(page);
    await page.getByLabel('API 密钥', { exact: true }).fill('');
    await page.getByRole('button', { name: '测试能力', exact: true }).click();
    const results = page.getByRole('status', { name: '能力测试结果' });
    await expect(results).toContainText('工具：已验证');
    await saved(page);
    await expect(results).toContainText('文本：已验证');
    await expect(results).toContainText('图片：结果不符，未确认');
    expect(capabilities).toEqual(['text', 'imageInput', 'toolCalls']);
    const model = (await getSettings(context.request)).providers[0].models[0];
    expect(model.testedCapabilities).toMatchObject({ toolCalls: true });
    expect(model.testedCapabilities).not.toHaveProperty('imageInput');
    expect(model.metadataOverrides).toEqual({ toolCalls: false });
    await expect(page.getByLabel('工具调用 1')).toHaveValue('unsupported');
    await page.getByLabel('工具调用 1').selectOption('auto');
    await saved(page);
    await expect(page.getByLabel('工具调用 1')).toContainText('自动（支持）');
    await expect(page.getByText('已验证', { exact: true })).toBeVisible();
    const id = crypto.randomUUID();
    conversations.push(id);
    expect(
      (
        await context.request.post('/api/conversations', {
          headers,
          data: { id, title: 'Capability backup' },
        })
      ).status(),
    ).toBe(201);
    const backup = await context.request
      .get(`/api/conversations/${id}/backup`)
      .then((r) => r.json());
    expect(backup.settings.providers[0].models[0].testedCapabilities).toEqual(
      model.testedCapabilities,
    );
    expect(JSON.stringify(backup)).not.toContain('integration-test-key');
    const restored = await context.request.post('/api/backup/restore', { headers, data: backup });
    expect(restored.status()).toBe(201);
    conversations.push((await restored.json()).id);
    expect((await getSettings(context.request)).providers[0].models[0].testedCapabilities).toEqual(
      model.testedCapabilities,
    );
  } finally {
    await page.close();
    for (const id of conversations)
      await context.request.delete(`/api/conversations/${id}`, { headers });
    expect((await f.restore()).status()).toBe(200);
  }
});

test('unconfirmed text stops later probes; late results cannot follow endpoint or model ID edits', async ({
  page,
  context,
}) => {
  const f = await setup(context.request, 'probe-mismatch');
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/models/test')) calls.push(request.postDataJSON().capability);
  });
  try {
    await openProvider(page);
    await page.getByRole('button', { name: '测试能力', exact: true }).click();
    await expect(page.getByRole('status', { name: '能力测试结果' })).toContainText(
      '文本：结果不符，未确认',
    );
    expect(calls).toEqual(['text']);
    expect((await getSettings(context.request)).providers[0].models[0]).not.toHaveProperty(
      'testedCapabilities',
    );
    for (const change of ['endpoint', 'model', 'key', 'protocol'] as const) {
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/models/test', async (route) => {
        await paused;
        await route
          .fulfill({
            json: {
              capability: route.request().postDataJSON().capability,
              status: 'confirmed',
              reason: 'matched',
              testedAt: Date.now(),
            },
          })
          .catch(() => {});
      });
      const request = page.waitForRequest('**/models/test');
      await page.getByRole('button', { name: '测试能力', exact: true }).click();
      await request;
      if (change === 'endpoint')
        await page.getByLabel('API 端点', { exact: true }).fill('https://provider.test/v2');
      else if (change === 'model')
        await page.getByLabel('模型 ID 1', { exact: true }).fill('probe-renamed');
      else if (change === 'key')
        await page.getByLabel('API 密钥', { exact: true }).fill('replacement-test-key');
      else await page.getByLabel('API 类型', { exact: true }).selectOption('anthropic');
      release();
      await saved(page);
      await expect(page.getByRole('button', { name: '测试能力', exact: true })).toBeEnabled();
      await expect(page.getByRole('status', { name: '能力测试结果' })).toHaveCount(0);
      expect((await getSettings(context.request)).providers[0].models[0]).not.toHaveProperty(
        'testedCapabilities',
      );
      await page.unroute('**/models/test');
    }
  } finally {
    await page.close();
    expect((await f.restore()).status()).toBe(200);
  }
});

test('unknown image capability can send actual native image bytes; confirmed false preserves the draft', async ({
  page,
  context,
}) => {
  const f = await setup(context.request, 'vision-openai-chat');
  const ids: string[] = [];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    await page.goto('/');
    await page
      .locator('input[type="file"][accept*="image"]')
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('button', { name: '移除 test.webp' })).toBeVisible();
    await page.getByLabel('消息', { exact: true }).fill('用户选择尝试未知图片能力');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\//);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    ids.push(id);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    const snapshot = (await context.request
      .get(`/api/conversations/${id}`)
      .then((r) => r.json())) as Snapshot;
    expect(snapshot.messages[0].parts?.some((part) => part.type === 'image')).toBe(true);
    const configuration = await getSettings(context.request);
    configuration.providers[0].models[0].metadataOverrides = { imageInput: false };
    expect(
      (
        await context.request.put('/api/settings/providers', { headers, data: configuration })
      ).status(),
    ).toBe(200);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).fill('保留不支持时的草稿');
    await page
      .locator('input[type="file"][accept*="image"]')
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('alert')).toContainText('请先选择支持图片的视觉模型');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留不支持时的草稿');
  } finally {
    await page.close();
    for (const id of ids) await context.request.delete(`/api/conversations/${id}`, { headers });
    expect((await f.restore()).status()).toBe(200);
  }
});

test('unknown tools remain opt-in; native API accepts a chosen tool while rejecting unauthenticated, cross-origin and invalid probes', async ({
  page,
  context,
  playwright,
}) => {
  const f = await setup(context.request, 'tools-service-openai-chat');
  const service = await context.request.get('/api/settings/web-tools').then((r) => r.json()),
    oldKey = await context.request.get('/api/settings/web-tools/key').then((r) => r.json());
  const ids: string[] = [];
  try {
    expect(
      (
        await context.request.put('/api/settings/web-tools', {
          headers,
          data: {
            provider: 'tavily',
            apiKey: 'tvly-browser-private-service-key',
            dailyLimit: service.usedToday + 20,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await openParameters(page, '联网');
    const checkbox = page.getByRole('switch', { name: '联网搜索', exact: true });
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByText('工具能力未识别，可尝试。', { exact: true })).toBeVisible();
    await checkbox.check();
    await page.getByRole('button', { name: '关闭会话参数', exact: true }).click();
    await page.getByLabel('消息', { exact: true }).fill('查阅资料');
    const response = page.waitForResponse(
      (r) =>
        /\/api\/conversations\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const taskId = accepted.request().postDataJSON().requestId;
    await expect(page).toHaveURL(/\/c\//);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    ids.push(id);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    const runtime = await context.request.post(`/api/__test/conversations/${id}/tool-runtime`, {
      headers,
      data: { taskId },
    });
    expect(runtime.ok()).toBe(true);
    const state = await runtime.json();
    expect(state.modelCalls).toBe(2);
    expect(state.serviceRequests.map((call: { url: string }) => call.url)).toEqual([
      'https://api.tavily.com/search',
      'https://api.tavily.com/extract',
    ]);
    const path = `/api/settings/providers/${f.providerId}/models/test`,
      data = { model: 'tools-service-openai-chat', capability: 'text' };
    const guest = await playwright.request.newContext({ baseURL: headers.Origin });
    try {
      expect((await guest.post(path, { headers, data })).status()).toBe(401);
    } finally {
      await guest.dispose();
    }
    expect(
      (
        await context.request.post(path, { headers: { Origin: 'https://untrusted.test' }, data })
      ).status(),
    ).toBe(403);
    expect(
      (
        await context.request.post(path, { headers, data: { ...data, capability: 'execute' } })
      ).status(),
    ).toBe(400);
    expect(
      (await context.request.post(path, { headers, data: { ...data, model: 'missing' } })).status(),
    ).toBe(404);
  } finally {
    await page.close();
    for (const id of ids) await context.request.delete(`/api/conversations/${id}`, { headers });
    await context.request.put('/api/settings/web-tools', {
      headers,
      data: {
        provider: service.provider,
        apiKey: oldKey.apiKey || '',
        dailyLimit: service.dailyLimit,
      },
    });
    expect((await f.restore()).status()).toBe(200);
  }
});
