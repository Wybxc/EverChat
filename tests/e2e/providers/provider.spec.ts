import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import {
  editModel,
  openModelAdder,
  openSpaceSettings,
  providerDetails,
} from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };
async function tab(page: Page, name: string) {
  const item = page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('tab', { name, exact: true });
  await item.focus();
  await item.press('Space');
  await expect(item).toHaveAttribute('aria-selected', 'true');
  if (name === '供应商') await providerDetails(page);
}
async function saved(page: Page) {
  await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill('everchat-local');
  await page.getByRole('button', { name: '进入我的空间' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}

test('provider settings and model discovery require a session and same-origin writes', async ({
  request,
}) => {
  expect(
    (await request.get(`/api/conversations/${crypto.randomUUID()}/measurements`)).status(),
  ).toBe(404);
  expect((await request.get('/api/settings/providers')).status()).toBe(401);
  expect((await request.put('/api/settings/providers', { headers, data: {} })).status()).toBe(401);
  expect((await request.put('/api/settings/providers', { data: {} })).status()).toBe(403);
  expect(
    (await request.get(`/api/settings/providers/${crypto.randomUUID()}/models`)).status(),
  ).toBe(401);
});

test('omitted output limits default to unset and can be configured or cleared with autosave', async ({
  page,
  context,
}) => {
  await login(page);
  const getSettings = () =>
    context.request
      .get('/api/settings/providers')
      .then((response) => response.json()) as Promise<ProviderSettings>;
  const initial = await getSettings();
  try {
    // Other tests configure this shared server. Exercise the omitted-field default explicitly.
    const { maxOutputTokens: _configuredLimit, ...withoutLimit } = initial;
    expect(
      (
        await context.request.put('/api/settings/providers', { headers, data: withoutLimit })
      ).status(),
    ).toBe(200);
    expect((await getSettings()).maxOutputTokens).toBeNull();
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '对话');
    const limit = page.getByLabel('输出上限（Tokens）');
    await expect(limit).toHaveValue('');
    await expect(limit).toHaveAttribute('placeholder', '不设置');
    await limit.fill('512');
    await saved(page);
    expect((await getSettings()).maxOutputTokens).toBe(512);
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '对话');
    await expect(limit).toHaveValue('512');
    await limit.fill('');
    await saved(page);
    expect((await getSettings()).maxOutputTokens).toBeNull();
    expect(
      await context.request.get('/api/session').then((response) => response.json()),
    ).toMatchObject({ maxOutputTokens: null });
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '对话');
    await expect(limit).toHaveValue('');
  } finally {
    await page.close();
    expect(
      (await context.request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});

test('changing provider protocol and endpoint preserves other inputs, model drafts and saved configuration', async ({
  page,
  context,
}) => {
  await login(page);
  const getSettings = () =>
    context.request
      .get('/api/settings/providers')
      .then((response) => response.json()) as Promise<ProviderSettings>;
  const initial = await getSettings();
  const profile = {
    id: crypto.randomUUID(),
    name: '自定义供应商',
    provider: 'openai-chat' as const,
    baseUrl: 'https://custom-provider.test/v1',
    apiKey: 'keep-provider-key',
    models: [
      {
        id: 'custom-model',
        name: '自定义显示名',
        enabled: true,
        useGlobalSystemPrompt: false,
        systemPrompt: '模型专属提示词',
        reasoningSupport: 'supported' as const,
        metadataOverrides: {
          contextWindow: 32000,
          maxOutputTokens: 4000,
          imageInput: true,
          reasoningEfforts: ['low', 'high'] as ('low' | 'high')[],
        },
      },
      { id: 'disabled-model', name: '停用模型', enabled: false },
    ],
  };
  try {
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers,
          data: {
            ...initial,
            providers: [profile],
            activeProviderId: profile.id,
            activeModel: 'custom-model',
            systemPrompt: '统一提示词',
          },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await editModel(page);
    await openModelAdder(page);
    await page.getByLabel('新模型 ID', { exact: true }).fill('unfinished-model');
    await page.getByLabel('新模型显示名').fill('尚未添加的模型');
    await page.getByRole('button', { name: '显示 API 密钥' }).click();

    const assertInputs = async (baseUrl: string) => {
      await expect(page.getByLabel('名称', { exact: true })).toHaveValue(profile.name);
      await expect(page.getByLabel('API 端点')).toHaveValue(baseUrl);
      await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue(profile.apiKey);
      await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'text');
      await expect(
        page.getByRole('checkbox', { name: '启用模型 自定义显示名', exact: true }),
      ).toBeChecked();
      await expect(
        page.getByRole('checkbox', { name: '启用模型 停用模型', exact: true }),
      ).not.toBeChecked();
      await expect(page.getByLabel('模型 ID 1', { exact: true })).toHaveValue('custom-model');
      await expect(page.getByLabel('模型显示名 1', { exact: true })).toHaveValue('自定义显示名');
      await expect(page.getByLabel('模型专属提示词 1', { exact: true })).toHaveValue(
        '模型专属提示词',
      );
      await expect(page.getByLabel('新模型 ID', { exact: true })).toHaveValue('unfinished-model');
      await expect(page.getByLabel('新模型显示名')).toHaveValue('尚未添加的模型');
    };
    for (const provider of ['anthropic', 'openai-responses', 'gemini', 'openai-chat']) {
      await page.getByLabel('API 类型').selectOption(provider);
      await assertInputs(profile.baseUrl);
      await saved(page);
      expect((await getSettings()).providers).toEqual([{ ...profile, provider, hasApiKey: true }]);
    }
    // Intermediate invalid input must not erase credentials or model settings either.
    await page.getByLabel('API 端点').fill('');
    await assertInputs('');
    await expect(page.getByTestId('settings-save-status')).toHaveAttribute('role', 'alert');
    expect((await getSettings()).providers[0].baseUrl).toBe(profile.baseUrl);
    const endpoint = 'https://edited-provider.test/v2';
    await page.getByLabel('API 端点').fill(endpoint);
    await assertInputs(endpoint);
    await saved(page);
    expect(await getSettings()).toMatchObject({
      providers: [{ ...profile, baseUrl: endpoint, hasApiKey: true }],
      activeProviderId: profile.id,
      activeModel: 'custom-model',
      systemPrompt: '统一提示词',
    });
    await tab(page, '对话');
    await expect(page.getByLabel('默认模型')).toHaveValue(
      JSON.stringify([profile.id, 'custom-model']),
    );
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await expect(page.getByLabel('API 端点')).toHaveValue(endpoint);
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue(profile.apiKey);
    expect((await getSettings()).providers[0].models).toEqual(profile.models);
  } finally {
    await page.close();
    expect(
      (await context.request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});

test('new providers start unnamed and autosave only after a nonblank name is supplied', async ({
  page,
  context,
}) => {
  await login(page);
  const getSettings = () =>
    context.request
      .get('/api/settings/providers')
      .then((response) => response.json()) as Promise<ProviderSettings>;
  const initial = await getSettings();
  try {
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers,
          data: { ...initial, providers: [], activeProviderId: null, activeModel: '' },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    let writes = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/settings/providers'
      )
        writes++;
    });
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await page.getByRole('button', { name: '添加供应商' }).click();
    const name = page.getByLabel('名称', { exact: true });
    await expect(name).toHaveValue('');
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('名称不能为空。', { exact: true })).toBeVisible();
    await page.getByLabel('API 类型').selectOption('anthropic');
    await page.getByLabel('API 端点').fill('https://new-provider.test/v1');
    await page.getByLabel('API 密钥', { exact: true }).fill('new-provider-key');
    await openModelAdder(page);
    await page.getByLabel('新模型 ID', { exact: true }).fill('new-model');
    await page.getByLabel('新模型显示名').fill('新模型');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.getByTestId('settings-save-status')).toHaveText(
      '未保存 · 请填写供应商名称。',
    );
    expect(writes).toBe(0);
    expect((await getSettings()).providers).toEqual([]);
    await name.fill('   ');
    await expect(page.getByTestId('settings-save-status')).toHaveText(
      '未保存 · 请填写供应商名称。',
    );
    expect(writes).toBe(0);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await openSpaceSettings(page);
    await expect(name).toHaveValue('   ');
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('new-provider-key');
    await expect(
      page.getByRole('checkbox', { name: '启用模型 新模型', exact: true }),
    ).toBeChecked();
    expect((await getSettings()).providers).toEqual([]);
    await name.fill('  我的供应商  ');
    await saved(page);
    expect(writes).toBeGreaterThan(0);
    const configured = (await getSettings()).providers[0];
    expect(configured).toMatchObject({
      name: '我的供应商',
      provider: 'anthropic',
      baseUrl: 'https://new-provider.test/v1',
      apiKey: 'new-provider-key',
      hasApiKey: true,
      models: [{ id: 'new-model', name: '新模型', enabled: true }],
    });
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await expect(name).toHaveValue('我的供应商');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await name.fill('');
    await expect(page.getByTestId('settings-save-status')).toHaveText(
      '未保存 · 请填写供应商名称。',
    );
    expect((await getSettings()).providers[0]).toEqual(configured);
    await name.fill('修正后的名称');
    await saved(page);
    expect((await getSettings()).providers[0]).toEqual({ ...configured, name: '修正后的名称' });
  } finally {
    await page.close();
    expect(
      (await context.request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});

test('tabbed settings autosave model names and enabled choices; the close button stays visible', async ({
  page,
  context,
  browser,
}) => {
  await login(page);
  const getSettings = () =>
    context.request
      .get('/api/settings/providers')
      .then((response) => response.json()) as Promise<ProviderSettings>;
  const initial = await getSettings();
  try {
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers,
          data: { ...initial, providers: [], activeProviderId: null, activeModel: '' },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await expect(page.getByRole('button', { name: '配置模型' })).toBeVisible();
    await page.getByLabel('消息', { exact: true }).fill('尚未选择模型');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0);
    await page.getByRole('button', { name: '添加供应商' }).click();
    await page.getByLabel('名称', { exact: true }).fill('OpenAI 主账号');
    await page.getByLabel('API 类型').selectOption('openai-chat');
    await page.getByLabel('API 端点').fill('https://provider.test/v1');
    await page.getByLabel('API 密钥', { exact: true }).fill('integration-test-key');
    await openModelAdder(page);
    await page.getByLabel('新模型 ID', { exact: true }).fill('gpt-test');
    await page.getByLabel('新模型显示名').fill('主模型');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await editModel(page);
    await page.getByLabel('模型 ID 1', { exact: true }).fill('gpt-chat-one');
    await saved(page);
    await expect(
      page.getByRole('checkbox', { name: '启用模型 主模型', exact: true }),
    ).toBeChecked();
    expect((await getSettings()).providers[0].models).toEqual([
      { id: 'gpt-chat-one', name: '主模型', enabled: true },
    ]);
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('integration-test-key');
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '显示 API 密钥' }).click();
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: '隐藏 API 密钥' }).click();

    await page.getByRole('button', { name: '获取', exact: true }).click();
    await expect(page.getByText('已获取 2 个模型', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: '启用模型 test-model', exact: true }),
    ).not.toBeChecked();
    await page.getByRole('checkbox', { name: '启用模型 test-model', exact: true }).check();
    await page.getByRole('checkbox', { name: '启用模型 test-model-2', exact: true }).check();
    await editModel(page, 2);
    await page.getByLabel('模型显示名 2').fill('快速模型');
    await saved(page);
    expect((await getSettings()).providers[0].models.every((model) => model.enabled)).toBe(true);
    await page.getByRole('button', { name: '获取', exact: true }).click();
    await expect(page.getByText('已获取 2 个模型', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: '启用模型 快速模型', exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel('模型显示名 2')).toHaveValue('快速模型');
    await tab(page, '对话');
    const profileId = (await getSettings()).providers[0].id;
    await page.getByLabel('显示思考内容', { exact: true }).check();
    await page.getByLabel('默认模型').selectOption(JSON.stringify([profileId, 'test-model']));
    await page.getByLabel('系统提示词', { exact: true }).fill('自动保存的提示词');
    await page.getByLabel('输出上限（Tokens）').fill('256');
    await saved(page);
    expect(
      await context.request.get('/api/session').then((response) => response.json()),
    ).toMatchObject({ model: 'test-model', modelName: '快速模型' });
    await tab(page, '供应商');
    await page.getByRole('checkbox', { name: '启用模型 快速模型', exact: true }).uncheck();
    await saved(page);
    await tab(page, '对话');
    await expect(page.getByLabel('默认模型').locator('option')).not.toContainText(['快速模型']);
    expect((await getSettings()).activeModel).toBe('gpt-chat-one');
    await tab(page, '供应商');

    await page.getByRole('button', { name: '添加供应商' }).click();
    await page.getByLabel('名称', { exact: true }).fill('Gemini 备用');
    await page.getByLabel('API 类型').selectOption('gemini');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-secret-gemini');
    await openModelAdder(page);
    await page.getByLabel('新模型 ID', { exact: true }).fill('gemini-manual');
    await page.getByLabel('新模型显示名').fill('备用模型');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await saved(page);
    await tab(page, '对话');
    let settings = await getSettings();
    await page
      .getByLabel('默认模型')
      .selectOption(JSON.stringify([settings.providers[1].id, 'gemini-manual']));
    await saved(page);
    await tab(page, '供应商');
    await page.getByRole('button', { name: '显示 API 密钥' }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await openSpaceSettings(page);
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('test-secret-gemini');
    expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toMatch(
      /test-secret|integration-test-key/,
    );
    const databaseContainsSecret = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction('keyval').objectStore('keyval').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return /test-secret|integration-test-key/.test(JSON.stringify(values));
      } finally {
        database.close();
      }
    });
    expect(databaseContainsSecret).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await providerDetails(page);
    await openModelAdder(page);
    const scroll = page.getByTestId('settings-scroll');
    await scroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    expect(await scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport();
    await expect(page.getByRole('tab', { name: '通用', exact: true })).toBeInViewport();
    await page.screenshot({
      path: 'test-results/provider-settings-light.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await openSpaceSettings(page);
    await tab(page, '通用');
    await page.getByRole('radio', { name: '深色' }).focus();
    await page.getByRole('radio', { name: '深色' }).press('Space');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await tab(page, '供应商');
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: 'test-results/provider-settings-dark.png',
      animations: 'disabled',
    });
    settings = await getSettings();
    const second = await browser.newContext();
    try {
      expect(
        (
          await second.request.post('/api/login', { headers, data: { password: 'everchat-local' } })
        ).status(),
      ).toBe(200);
      expect(
        await second.request.get('/api/settings/providers').then((response) => response.json()),
      ).toEqual(settings);
      expect(
        await second.request.get('/api/session').then((response) => response.json()),
      ).toMatchObject({ provider: 'gemini', model: 'gemini-manual', modelName: '备用模型' });
    } finally {
      await second.close();
    }

    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    settings = await getSettings();
    expect(
      (
        await context.request.put('/api/settings/providers', {
          headers,
          data: { ...settings, systemPrompt: '其他设备更新' },
        })
      ).status(),
    ).toBe(200);
    await openSpaceSettings(page);
    await tab(page, '对话');
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveValue('其他设备更新');
    await tab(page, '供应商');

    await page.getByRole('button', { name: '删除供应商 Gemini 备用' }).click();
    await page
      .getByRole('alertdialog', { name: '删除供应商', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click();
    await providerDetails(page);
    await saved(page);
    await page.getByRole('checkbox', { name: '启用模型 主模型', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '启用模型 test-model-2', exact: true }).uncheck();
    await saved(page);
    expect(
      await context.request.get('/api/session').then((response) => response.json()),
    ).toMatchObject({ provider: '', model: '' });
    const conversationId = crypto.randomUUID();
    expect(
      (
        await context.request.post('/api/conversations', {
          headers,
          data: { id: conversationId, title: 'No model' },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await context.request.post(`/api/conversations/${conversationId}/messages`, {
          headers,
          data: { parentId: null, requestId: crypto.randomUUID(), content: '禁用模型不可生成' },
        })
      ).status(),
    ).toBe(400);
    expect(
      await context.request
        .get(`/api/conversations/${conversationId}`)
        .then((response) => response.json()),
    ).toMatchObject({ messages: [] });
    await page.getByLabel('名称', { exact: true }).fill('关闭窗口时保存');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect.poll(async () => (await getSettings()).providers[0].name).toBe('关闭窗口时保存');
    await page.reload();
    await openSpaceSettings(page);
    await tab(page, '供应商');
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('关闭窗口时保存');
  } finally {
    await page.close();
    expect(
      (await context.request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});

test('autosave validation and network failures preserve drafts and allow retry', async ({
  page,
  context,
}) => {
  await login(page);
  const getSettings = () =>
    context.request
      .get('/api/settings/providers')
      .then((response) => response.json()) as Promise<ProviderSettings>;
  const initial = await getSettings();
  try {
    await openSpaceSettings(page);
    await tab(page, '对话');
    await page.getByLabel('输出上限（Tokens）').fill('0');
    await expect(page.getByTestId('settings-save-status')).toHaveAttribute('role', 'alert');
    expect((await getSettings()).maxOutputTokens).toBe(initial.maxOutputTokens);
    await page.getByLabel('输出上限（Tokens）').fill('512');
    await saved(page);
    await page.route('**/api/settings/providers', async (route) => {
      if (route.request().method() === 'PUT')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '暂时无法保存' }),
        });
      else await route.continue();
    });
    await page.getByLabel('系统提示词', { exact: true }).fill('失败后保留的草稿');
    await expect(page.getByTestId('settings-save-status')).toContainText('暂时无法保存');
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveValue('失败后保留的草稿');
    await page.unroute('**/api/settings/providers');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await saved(page);
    expect((await getSettings()).systemPrompt).toBe('失败后保留的草稿');
  } finally {
    await page.close();
    expect(
      (await context.request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});
