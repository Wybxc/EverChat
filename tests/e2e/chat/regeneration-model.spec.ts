import { expect, test } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { chooseChatModel } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('regeneration fixes the currently chosen provider, prompt and model title without consuming another draft', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const firstProvider = crypto.randomUUID(),
    secondProvider = crypto.randomUUID(),
    id = crypto.randomUUID();
  const model = 'metadata-reasoning';
  try {
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            ...original,
            systemPrompt: 'Global instructions',
            activeProviderId: firstProvider,
            activeModel: model,
            providers: [firstProvider, secondProvider].map((providerId, index) => ({
              id: providerId,
              name: `Provider ${index + 1}`,
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: model,
                  name: `Model ${index + 1}`,
                  enabled: true,
                  systemPrompt: `Instructions ${index + 1}`,
                  useGlobalSystemPrompt: false,
                  reasoningSupport: 'supported',
                },
              ],
            })),
          },
        })
      ).ok(),
    ).toBe(true);
    await page.request.post('/api/conversations', { headers, data: { id, title: '重新生成模型' } });
    await page.request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '保留原来的提问',
        parentId: null,
        selection: { providerId: firstProvider, model },
      },
    });
    const snapshot = () =>
      page.request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
    await expect.poll(async () => (await snapshot()).messages[1]?.status).toBe('completed');
    const first = (await snapshot()).messages[1];
    await page.goto(`/c/${id}`);
    await chooseChatModel(page, JSON.stringify([secondProvider, model]));
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('不能被重生成清空的草稿');
    await page.getByLabel('思维强度', { exact: true }).selectOption('high');
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/conversations/${id}/messages`),
    );
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    const accepted = await (await response).json();
    const run = await page.request
      .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId: accepted.runId } })
      .then((r) => r.json());
    expect(run.config).toMatchObject({
      providerId: secondProvider,
      model,
      modelName: 'Model 2',
      systemPrompt: 'Instructions 2',
      reasoningEffort: 'high',
    });
    expect(run.context).toEqual([{ role: 'user', content: '保留原来的提问' }]);
    await expect(editor).toHaveValue('不能被重生成清空的草稿');
    await chooseChatModel(page, JSON.stringify([firstProvider, model]));
    const answer = page.locator(`[data-message-id="${accepted.assistantId}"]`);
    await expect(answer).toContainText('Model 2');
    await expect(answer).toHaveAttribute('data-status', 'completed');
    const saved = (await snapshot()).messages;
    expect(saved.find((m) => m.id === first.id)).toEqual(first);
    expect(saved.at(-1)).toMatchObject({
      providerId: secondProvider,
      model,
      modelName: 'Model 2',
      parentId: first.parentId,
    });
    await page.reload();
    await expect(editor).toHaveValue('不能被重生成清空的草稿');
    await expect(answer).toContainText('Model 2');
    await chooseChatModel(page, JSON.stringify([secondProvider, model]));
    await page.context().setOffline(true);
    await answer.getByRole('button', { name: '重新生成', exact: true }).click();
    const pending = page.getByTestId('pending-message');
    await expect(pending).toContainText('等待发送');
    await expect(pending).toContainText('Model 2');
    await chooseChatModel(page, JSON.stringify([firstProvider, model]));
    await expect(pending).toContainText('Model 2');
    await expect(editor).toHaveValue('不能被重生成清空的草稿');
    const delivered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/conversations/${id}/messages`),
    );
    await page.context().setOffline(false);
    const deliveredResponse = await delivered;
    expect(deliveredResponse.request().postDataJSON().selection).toEqual({
      providerId: secondProvider,
      model,
    });
    const offlineAccepted = await deliveredResponse.json();
    const offlineAnswer = page.locator(`[data-message-id="${offlineAccepted.assistantId}"]`);
    await expect(offlineAnswer).toContainText('Model 2');
    await expect(offlineAnswer).toHaveAttribute('data-status', 'completed');
    await expect(editor).toHaveValue('不能被重生成清空的草稿');
  } finally {
    await page.context().setOffline(false);
    await page.request.delete(`/api/conversations/${id}`, { headers });
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});
