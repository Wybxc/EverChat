import { expect, test, type APIRequestContext } from '@playwright/test';
import { DEFAULT_PROMPT_PRESET_ID } from '../../../shared/presets/types';
import { messageText } from '../../../shared/conversation/content';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { openParameters, openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  await request.post('/__dev/access/login', { headers });
  const original = await request.get('/api/settings/providers').then((r) => r.json());
  const providerId = crypto.randomUUID();
  await request.put('/api/settings/providers', {
    headers,
    data: {
      providers: [
        {
          id: providerId,
          name: '配置验证',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [{ id: 'raw-openai-chat', name: '测试模型', enabled: true }],
        },
      ],
      activeProviderId: providerId,
      activeModel: 'raw-openai-chat',
      systemPrompt: '原统一提示词',
      maxOutputTokens: null,
    },
  });
  return async () => {
    await request.put('/api/settings/providers', { headers, data: original });
  };
}
for (const width of [1280, 390])
  test.describe(`${width}px layout`, () => {
    test.use({ hasTouch: width === 390 });
    test(`default preset editing and quick switching preserve other settings at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const restore = await setup(page.request),
        presetId = crypto.randomUUID();
      let conversationId = '';
      try {
        expect(
          (
            await page.request.delete(`/api/settings/presets/${DEFAULT_PROMPT_PRESET_ID}`, {
              headers,
            })
          ).status(),
        ).toBe(400);
        expect(
          (
            await page.request.put(`/api/settings/presets/${DEFAULT_PROMPT_PRESET_ID}`, {
              headers,
              data: { name: '不可重命名', systemPrompt: '不能改' },
            })
          ).status(),
        ).toBe(400);
        await page.request.put(`/api/settings/presets/${presetId}`, {
          headers,
          data: { name: '写作', systemPrompt: '写作预设内容' },
        });
        const before = await page.request.get('/api/settings/providers').then((r) => r.json());
        await page.goto('/');
        await openSpaceSettings(page);
        await page.getByRole('tab', { name: '对话', exact: true }).click();
        await expect(page.getByLabel('系统提示词', { exact: true })).toHaveCount(0);
        await expect(page.getByLabel('输出上限（Tokens）', { exact: true })).toHaveCount(0);
        await page.getByRole('tab', { name: '预设', exact: true }).click();
        await page.getByLabel('编辑预设', { exact: true }).selectOption(DEFAULT_PROMPT_PRESET_ID);
        await expect(page.getByLabel('预设名称', { exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: '删除预设', exact: true })).toHaveCount(0);
        await expect(page.getByLabel('预设系统提示词', { exact: true })).toHaveValue(
          '原统一提示词',
        );
        await page.getByLabel('预设系统提示词', { exact: true }).fill('新的默认预设');
        await expect(page.getByTestId('preset-save-status')).toHaveText('已保存');
        const after = await page.request.get('/api/settings/providers').then((r) => r.json());
        expect(after).toEqual({ ...before, systemPrompt: '新的默认预设' });
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        const picker = page.getByRole('combobox', { name: '新对话预设', exact: true });
        await picker.selectOption(presetId);
        await expect(picker).toHaveValue(presetId);
        await picker.selectOption(DEFAULT_PROMPT_PRESET_ID);
        await expect(picker).toHaveValue(DEFAULT_PROMPT_PRESET_ID);
        await picker.selectOption(presetId);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (width === 390)
          expect(
            await picker.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
          ).toBeGreaterThanOrEqual(16);
        await page.screenshot({
          path: `test-results/preset-header-${width}.png`,
          animations: 'disabled',
        });
        await openParameters(page);
        const parameters = page.getByRole('dialog', { name: '新对话参数', exact: true });
        await expect(parameters.getByLabel('会话系统提示词', { exact: true })).toHaveValue(
          '写作预设内容',
        );
        await expect(parameters.locator('details')).toHaveCount(0);
        await parameters.getByRole('tab', { name: '上下文', exact: true }).click();
        await parameters.getByLabel('输出预算方式').selectOption('custom');
        await parameters.getByLabel('输出 Token 预算', { exact: true }).fill('256');
        await parameters.getByRole('button', { name: '关闭会话参数' }).click();
        await page.getByLabel('消息', { exact: true }).fill('使用快速预设');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await expect(page).toHaveURL(/\/c\/[0-9a-f-]+/);
        conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
        await expect
          .poll(
            async () =>
              (await page.request.get(`/api/conversations/${conversationId}`).then((r) => r.json()))
                .settings,
          )
          .toMatchObject({
            systemPrompt: '写作预设内容',
            maxOutputTokens: 256,
            useGlobalMaxOutputTokens: false,
          });
        await expect(picker).toHaveCount(0);
      } finally {
        if (conversationId)
          await page.request.delete(`/api/conversations/${conversationId}`, { headers });
        await page.request.delete(`/api/settings/presets/${presetId}`, { headers });
        await restore();
      }
    });

    test(`long user messages collapse at ${width}px and searches reveal matching text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const restore = await setup(page.request),
        id = crypto.randomUUID();
      const content =
        Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行，完整保留的用户消息。`).join('\n') +
        '\n只在末尾出现的关键词';
      try {
        await page.request.post('/api/conversations', { headers, data: { id, title: '长消息' } });
        await page.request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: { requestId: crypto.randomUUID(), parentId: null, content },
        });
        const snapshot = () =>
          page.request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
        await expect.poll(async () => (await snapshot()).messages.at(-1)?.status).toBe('completed');
        await page.goto(`/c/${id}`);
        const message = page.getByTestId('user-message').first();
        const text = message.locator('[data-search-content]');
        await expect(message.getByRole('button', { name: '展开消息', exact: true })).toBeVisible();
        await expect(text).toHaveText(content);
        expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        await page.screenshot({
          path: `test-results/collapsed-message-${width}.png`,
          animations: 'disabled',
        });
        await message.getByRole('button', { name: '展开消息', exact: true }).click();
        await expect
          .poll(() => text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1))
          .toBe(true);
        await message.getByRole('button', { name: '收起消息', exact: true }).click();
        await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
        await page
          .getByRole('textbox', { name: '查找当前对话', exact: true })
          .fill('只在末尾出现的关键词');
        await expect(message.getByRole('button', { name: '收起消息', exact: true })).toBeVisible();
        await expect
          .poll(() => text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1))
          .toBe(true);
        expect(messageText((await snapshot()).messages.find((m) => m.role === 'user'))).toBe(
          content,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await page.request.delete(`/api/conversations/${id}`, { headers });
        await restore();
      }
    });
  });
