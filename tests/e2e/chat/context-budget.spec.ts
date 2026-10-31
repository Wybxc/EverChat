import { expect, test, type APIRequestContext } from '@playwright/test';
import type { EverChatBackup } from '../../../shared/backup/backup';
import { messageParts } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS as defaults } from '../../../shared/conversation/settings';
import type { ConversationSettings, Submission } from '../../../shared/conversation/types';
import type { ProviderSettings, ProviderSettingsInput } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { messageMenu, openParameters } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
async function setup(request: APIRequestContext, window: number | null = 4096) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    empty = crypto.randomUUID(),
    ids: string[] = [empty];
  const configuration: ProviderSettingsInput = {
    providers: [
      {
        id: providerId,
        name: 'Budget fixture',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        models: [
          {
            id: 'alarm-stall',
            name: 'Budget Model',
            enabled: true,
            useGlobalSystemPrompt: false,
            systemPrompt: 'MODEL',
            ...(window === null
              ? {}
              : { metadataOverrides: { contextWindow: window, maxOutputTokens: 1024 } }),
          },
        ],
      },
    ],
    activeProviderId: providerId,
    activeModel: 'alarm-stall',
    systemPrompt: 'GLOBAL',
    maxOutputTokens: null,
  };
  expect(
    (await request.put('/api/settings/providers', { headers, data: configuration })).status(),
  ).toBe(200);
  expect(
    (
      await request.post('/api/conversations', {
        headers,
        data: { id: empty, title: '上下文预算' },
      })
    ).status(),
  ).toBe(201);
  const backup = (await request
    .get(`/api/conversations/${empty}/backup`)
    .then((response) => response.json())) as EverChatBackup;
  let parentId: string | null = null;
  backup.conversation.messages = ['旧问题', '旧回答', '新问题', '新回答'].map((text, index) => {
    const id = crypto.randomUUID(),
      message = {
        id,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        parts: messageParts(text.repeat(20)),
        status: 'completed' as const,
        createdAt: index + 1,
        parentId,
        revisionOf: null,
        error: null,
        providerId: null,
        model: null,
        modelName: null,
      };
    parentId = id;
    return message;
  });
  const restored = await request.post('/api/backup/restore', { headers, data: backup });
  expect(restored.status()).toBe(201);
  const { id, snapshot: seeded } = (await restored.json()) as { id: string; snapshot: Snapshot };
  ids.push(id);
  expect(
    (await request.put('/api/settings/providers', { headers, data: configuration })).status(),
  ).toBe(200);
  const snapshot = () =>
    request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json()) as Promise<Snapshot>;
  const submit = (patch: object = {}) =>
    request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: 'next',
        ...(!('retryOf' in patch) && !('revisionOf' in patch)
          ? { parentId: seeded.messages.at(-1)!.id }
          : {}),
        ...patch,
      },
    });
  const run = (runId: string) =>
    request
      .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } })
      .then((response) => response.json());
  const stop = (runId: string) =>
    request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId } });
  const save = (settings: ConversationSettings) =>
    request.put(`/api/conversations/${id}/settings`, { headers, data: settings });
  return {
    id,
    seeded,
    configuration,
    snapshot,
    submit,
    run,
    stop,
    save,
    ids,
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      expect(
        (await request.put('/api/settings/providers', { headers, data: original })).status(),
      ).toBe(200);
    },
  };
}

test('cloud budgeting rejects oversized fixed input, keeps a complete branch suffix and pins its estimate through copies and restore', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const settings = { ...defaults, contextBudget: 300, recentMessages: 3 };
    for (const patch of [
      { contextBudget: 0 },
      { contextBudget: 1.1 },
      { contextBudget: Number.MAX_SAFE_INTEGER + 1 },
      { recentMessages: 0 },
      { recentMessages: Number.MAX_SAFE_INTEGER + 1 },
      { recentMessages: 1.1 },
    ])
      expect((await fixture.save({ ...defaults, ...patch })).status()).toBe(400);
    const invalid = await fixture.submit({ content: '中'.repeat(300), settings });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toContain('超过上下文预算');
    expect((await fixture.snapshot()).messages).toHaveLength(4);
    expect(
      await request
        .post(`/api/__test/conversations/${fixture.id}/resources`, { headers, data: {} })
        .then((response) => response.json()),
    ).toMatchObject({ calls: 0, runs: 0 });
    const accepted = await fixture.submit({ settings });
    expect(accepted.status()).toBe(202);
    const task = (await accepted.json()) as Submission;
    const pinned = await fixture.run(task.runId);
    expect(
      pinned.context.map(({ role, content }: { role: string; content: string }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: 'user', content: '新问题'.repeat(20) },
      { role: 'assistant', content: '新回答'.repeat(20) },
      { role: 'user', content: 'next' },
    ]);
    expect(pinned.config).toMatchObject({ systemPrompt: 'MODEL', maxOutputTokens: null });
    const estimate = (await fixture.snapshot()).messages.at(-1)!.generation!.context!;
    expect(estimate).toMatchObject({
      method: 'approximate-v1',
      inputBudget: 300,
      retainedMessages: 2,
      omittedMessages: 2,
      outputReserve: 0,
      windowSource: 'manual',
    });
    expect(estimate.totalTokens).toBeLessThanOrEqual(300);
    expect(
      (await fixture.save({ ...defaults, contextBudget: 1, recentMessages: 1 })).status(),
    ).toBe(200);
    const changed = structuredClone(fixture.configuration);
    changed.providers[0].models[0].systemPrompt = 'CHANGED';
    expect(
      (await request.put('/api/settings/providers', { headers, data: changed })).status(),
    ).toBe(200);
    expect(await fixture.run(task.runId)).toEqual(pinned);
    await fixture.stop(task.runId);
    expect((await fixture.snapshot()).messages.at(-1)!.generation!.context).toEqual(estimate);
    const copied = await request
      .post(`/api/conversations/${fixture.id}/duplicate`, {
        headers,
        data: { requestId: crypto.randomUUID() },
      })
      .then((response) => response.json());
    fixture.ids.push(copied.id);
    expect(copied.snapshot.messages.at(-1).generation.context).toEqual(estimate);
    expect(copied.snapshot.settings).toMatchObject({ contextBudget: 1, recentMessages: 1 });
    const backup = (await request
      .get(`/api/conversations/${fixture.id}/backup`)
      .then((response) => response.json())) as EverChatBackup;
    expect(backup.conversation.messages.at(-1)!.generation!.context).toEqual(estimate);
    expect(JSON.stringify(backup)).not.toContain('integration-test-key');
    const restored = await request.post('/api/backup/restore', { headers, data: backup });
    expect(restored.status()).toBe(201);
    const restoredCopy = await restored.json();
    fixture.ids.push(restoredCopy.id);
    expect(restoredCopy.snapshot.messages.at(-1).generation.context).toEqual(estimate);
    expect(restoredCopy.snapshot.settings).toMatchObject({ contextBudget: 1, recentMessages: 1 });
    expect(
      (
        await request.put('/api/settings/providers', { headers, data: fixture.configuration })
      ).status(),
    ).toBe(200);
    const older = await fixture.submit({ settings, parentId: fixture.seeded.messages[1].id });
    expect(older.status()).toBe(202);
    const olderTask = (await older.json()) as Submission;
    expect(
      (await fixture.run(olderTask.runId)).context.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual(['旧问题'.repeat(20), '旧回答'.repeat(20), 'next']);
    await fixture.stop(olderTask.runId);
    const retry = await fixture.submit({ content: undefined, retryOf: task.assistantId, settings });
    expect(retry.status()).toBe(202);
    const retryTask = (await retry.json()) as Submission;
    expect((await fixture.run(retryTask.runId)).context).toEqual(pinned.context);
    await fixture.stop(retryTask.runId);
    const revision = await fixture.submit({
      content: 'revised root',
      revisionOf: fixture.seeded.messages[0].id,
      settings,
    });
    expect(revision.status()).toBe(202);
    const revisionTask = (await revision.json()) as Submission;
    expect(
      (await fixture.run(revisionTask.runId)).context.map(
        ({ role, content }: { role: string; content: string }) => ({ role, content }),
      ),
    ).toEqual([{ role: 'user', content: 'revised root' }]);
    await fixture.stop(revisionTask.runId);
  } finally {
    await fixture.cleanup();
  }
});

test('composer estimates reflect model prompts and autosaved budgets across devices, branches and offline edits', async ({
  page,
  browser,
  context,
}) => {
  const fixture = await setup(page.request),
    other = await browser.newContext({ locale: 'zh-CN' });
  try {
    expect(
      (await fixture.save({ ...defaults, contextBudget: 300, recentMessages: 3 })).status(),
    ).toBe(200);
    await page.goto(`/c/${fixture.id}`);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('next');
    const estimate = page.getByTestId('context-estimate');
    await expect(estimate).toHaveAttribute('aria-description', /上下文约.*\/ 300 Tokens/);
    await expect(page.getByTestId('context-omission')).toContainText('将省略 2 条');
    await page.getByRole('button', { name: '查看上下文估算' }).click();
    const details = page.getByRole('dialog', { name: '上下文估算', exact: true });
    await expect(details).toContainText('系统提示词（估算）');
    await expect(details.locator('dd').first()).toHaveText('10');
    await page.keyboard.press('Escape');
    await other.request.post('/__dev/access/login', { headers });
    const second = await other.newPage();
    await second.goto(`/c/${fixture.id}`);
    await openParameters(second, '上下文');
    await openParameters(page, '上下文');
    const modal = page.getByRole('dialog', { name: '会话参数', exact: true });
    await modal.getByLabel('上下文 Token 预算', { exact: true }).fill('350');
    await expect(modal.getByTestId('conversation-save-status')).toHaveText('已保存');
    await expect(second.getByLabel('上下文 Token 预算', { exact: true })).toHaveValue('350');
    await modal.getByLabel('最近历史消息条数', { exact: true }).fill('1');
    await expect(modal.getByTestId('conversation-save-status')).toHaveText('已保存');
    await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await expect(estimate).toHaveAttribute('aria-description', /\/ 350 Tokens/);
    await expect(page.getByTestId('context-omission')).toContainText('将省略 4 条');
    await expect(composer).toHaveValue('next');
    await messageMenu(page.getByTestId('assistant-message').first());
    await page.getByRole('menuitem', { name: '从这里继续', exact: true }).first().click();
    await expect(page.getByTestId('context-omission')).toContainText('将省略 2 条');
    await openParameters(page, '上下文');
    await context.setOffline(true);
    await modal.getByLabel('上下文 Token 预算', { exact: true }).fill('400');
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await expect(estimate).toHaveAttribute('aria-description', /\/ 400 Tokens/);
    await context.setOffline(false);
    await expect.poll(async () => (await fixture.snapshot()).settings?.contextBudget).toBe(400);
    await page.reload();
    await expect(composer).toHaveValue('next');
    await expect(estimate).toHaveAttribute('aria-description', /\/ 400 Tokens/);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    const sent = (await fixture.snapshot()).messages.at(-1)!;
    expect(sent.generation!.context).toMatchObject({
      inputBudget: 400,
      retainedMessages: 0,
      omittedMessages: 2,
    });
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await page
      .getByTestId('assistant-message')
      .last()
      .getByRole('button', { name: '生成信息', exact: true })
      .click();
    const info = page.getByTestId('message-generation');
    await expect(info.getByTestId('generation-contextMessages')).toHaveText('0 条 · 省略 2 条');
  } finally {
    await context.setOffline(false);
    await other.close();
    await fixture.cleanup();
  }
});

test('an unknown model displays unknown capacity and an over-budget draft stays focused at its original URL', async ({
  page,
}) => {
  const fixture = await setup(page.request, null);
  try {
    await page.goto('/');
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('保留当前草稿');
    await page.getByRole('button', { name: '查看上下文估算' }).click();
    await expect(page.getByRole('dialog', { name: '上下文估算', exact: true })).toContainText(
      '窗口未识别',
    );
    await page.keyboard.press('Escape');
    await openParameters(page, '上下文');
    const modal = page.getByRole('dialog', { name: '新对话参数', exact: true });
    await modal.getByLabel('上下文 Token 预算', { exact: true }).fill('1');
    await expect(modal.getByTestId('conversation-save-status')).toHaveText('已保存到本机');
    await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await expect(page.getByTestId('context-budget-warning')).toContainText('超过预算');
    await composer.press('Enter');
    await expect(page.getByRole('alert')).toContainText('超过上下文预算');
    await expect(composer).toHaveValue('保留当前草稿');
    await expect(composer).toBeFocused();
    await expect(page).toHaveURL(`${origin}/`);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]')),
    ).toHaveLength(0);
    await openParameters(page, '上下文');
    await modal.getByLabel('上下文 Token 预算', { exact: true }).fill('1.5');
    await expect(modal.getByRole('alert')).toContainText('正整数');
    await expect(modal.getByRole('button', { name: '关闭会话参数' })).toBeInViewport();
  } finally {
    await fixture.cleanup();
  }
});

test('cloud capacity distinguishes separate input limits from combined windows and clamps custom budgets', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const configuration = structuredClone(fixture.configuration);
    configuration.maxOutputTokens = 900;
    configuration.providers[0].models[0].metadataOverrides = {
      contextWindow: 1000,
      maxOutputTokens: 1000,
      contextScope: 'input',
    };
    expect(
      (await request.put('/api/settings/providers', { headers, data: configuration })).status(),
    ).toBe(200);
    const settings = { ...defaults, systemPrompt: '', contextBudget: 100000 };
    const accepted = await fixture.submit({ content: '中'.repeat(100), settings });
    expect(accepted.status()).toBe(202);
    const task = (await accepted.json()) as Submission;
    expect((await fixture.snapshot()).messages.at(-1)!.generation!.context).toMatchObject({
      contextScope: 'input',
      inputBudget: 1000,
      outputReserve: 900,
    });
    await fixture.stop(task.runId);
    const combined = {
      ...configuration,
      providers: configuration.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({
          ...model,
          metadataOverrides: { ...model.metadataOverrides, contextScope: 'combined' },
        })),
      })),
    };
    expect(
      (await request.put('/api/settings/providers', { headers, data: combined })).status(),
    ).toBe(200);
    const rejected = await fixture.submit({ content: '中'.repeat(100), settings });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toContain('超过上下文预算 100');
    expect((await fixture.snapshot()).messages).toHaveLength(6);
  } finally {
    await fixture.cleanup();
  }
});
