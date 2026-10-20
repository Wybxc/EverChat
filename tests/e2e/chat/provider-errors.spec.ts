import { expect, test } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { messageText } from '../../../shared/conversation/content';
import { chooseChatModel } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  for (const mode of ['http', 'stream', 'disconnect'] as const) {
    test(`${protocol} ${mode} failures expose safe diagnostics across reload, duplicate and backup restore`, async ({
      page,
    }, info) => {
      await page.request.post('/__dev/access/login', { headers });
      const original = (await page.request
        .get('/api/settings/providers')
        .then((r) => r.json())) as ProviderSettings;
      const id = crypto.randomUUID(),
        providerId = crypto.randomUUID(),
        nextProviderId = crypto.randomUUID(),
        extras: string[] = [];
      const nextModel = 'benchmark-text-10-150-20';
      const model = `diagnostic-${mode}`;
      const publicWire: string[] = [];
      page.on('websocket', (socket) =>
        socket.on('framereceived', ({ payload }) => {
          try {
            const event = JSON.parse(payload.toString());
            if (event.type === 'preview')
              publicWire.push(Buffer.from(event.batch.data, 'base64').toString());
            if (event.type === 'commit')
              for (const batch of event.batches)
                publicWire.push(Buffer.from(batch.data, 'base64').toString());
          } catch {
            /* Non-stream packets do not contain wire bytes. */
          }
        }),
      );
      try {
        expect(
          (
            await page.request.put('/api/settings/providers', {
              headers,
              data: {
                ...original,
                activeProviderId: providerId,
                activeModel: model,
                providers: [
                  {
                    id: providerId,
                    name: '错误诊断供应商',
                    provider: protocol,
                    baseUrl: 'https://provider.test/v1',
                    apiKey: 'integration-test-key',
                    models: [{ id: model, name: '诊断模型', enabled: true }],
                  },
                  {
                    id: nextProviderId,
                    name: '后续对话供应商',
                    provider: 'openai-chat',
                    baseUrl: 'https://provider.test/v1',
                    apiKey: 'integration-test-key',
                    models: [{ id: nextModel, name: '后续模型', enabled: true }],
                  },
                ],
              },
            })
          ).ok(),
        ).toBe(true);
        await page.request.post('/api/conversations', { headers, data: { id, title: '错误诊断' } });
        await page.addInitScript(() =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (value: string) => {
                (window as unknown as { diagnosticCopy: string }).diagnosticCopy = value;
              },
            },
          }),
        );
        await page.goto(`/c/${id}`);
        await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
        await page.request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: { requestId: crypto.randomUUID(), content: 'private question', parentId: null },
        });
        const snapshot = () =>
          page.request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
        await expect
          .poll(async () => (await snapshot()).messages[1]?.status)
          .toBe(mode !== 'http' ? 'completed' : 'failed');
        const message = (await snapshot()).messages[1];
        expect(message.generation?.interrupted).toBe(mode !== 'http' ? true : undefined);
        const failure = message.generation?.failure;
        expect(failure).toMatchObject({
          protocol,
          providerId,
          providerName: '错误诊断供应商',
          model,
          modelName: '诊断模型',
          endpoint: 'https://provider.test/v1',
        });
        // The local fetch proxy can surface a broken stream as a premature EOF.
        expect(
          mode === 'disconnect'
            ? ['stream', 'protocol']
            : [mode === 'http' ? 'response' : 'stream'],
        ).toContain(failure?.stage);
        expect(failure?.code).toBe(
          mode === 'http' ? 'invalid_api_key' : mode === 'stream' ? 'overloaded_error' : undefined,
        );
        expect(JSON.stringify(failure)).not.toContain('integration-test-key');
        expect(JSON.stringify(failure)).not.toContain('private question');
        expect(publicWire.join('')).not.toContain('integration-test-key');
        expect(publicWire.join('')).not.toContain('overloaded_error');
        if (mode !== 'http') {
          expect(messageText(message)).toBe('**正文🙂**\n');
          expect(messageText(message, 'reasoning')).toBe('**思考🙂**\n');
        } else {
          expect(failure?.status).toBe(401);
          expect(failure?.requestId).toBe('req-diagnostic-http');
          expect(failure?.responseBody).toContain('Authentication failed at the upstream gateway');
        }
        await page.getByTestId('provider-failure').locator('summary').click();
        await expect(page.getByTestId('provider-failure')).toContainText(failure?.code ?? model);
        if (mode === 'http') {
          await expect(page.getByTestId('provider-response-body')).toHaveText(
            failure!.responseBody!,
          );
          expect(
            await page.evaluate(() => Reflect.get(window, 'providerBodyExecuted')),
          ).toBeUndefined();
          await expect(page.getByTestId('provider-response-body').locator('script')).toHaveCount(0);
        }
        await page.getByRole('button', { name: '复制诊断信息', exact: true }).click();
        const copied = await page.evaluate(
          () => (window as unknown as { diagnosticCopy: string }).diagnosticCopy,
        );
        expect(copied).toContain(failure?.code ?? model);
        expect(copied).not.toContain('integration-test-key');
        if (mode === 'http') expect(copied).toContain(failure!.responseBody!);
        await page.screenshot({ path: info.outputPath(`provider-error-${mode}-${protocol}.png`) });
        await page.reload();
        await expect(page.getByTestId('provider-failure')).toBeVisible();
        expect((await snapshot()).messages[1].generation?.failure).toEqual(failure);
        if (mode === 'http') {
          const details = page.getByTestId('provider-failure').locator('summary');
          if (!(await page.getByTestId('provider-response-body').isVisible()))
            await details.click();
          await expect(page.getByTestId('provider-response-body')).toHaveText(
            failure!.responseBody!,
          );
        }
        if (mode !== 'http') {
          await expect(page.getByTestId('assistant-message')).toHaveAttribute(
            'data-status',
            'completed',
          );
          await expect(page.getByTestId('provider-failure')).toContainText(
            '已保留的内容将用于后续对话',
          );
          await chooseChatModel(page, JSON.stringify([nextProviderId, nextModel]));
          const accepted = page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              response.url().endsWith(`/conversations/${id}/messages`),
          );
          await page.getByRole('textbox', { name: '消息', exact: true }).fill('请接着说');
          await page.getByRole('button', { name: '发送消息', exact: true }).click();
          const { runId } = await (await accepted).json();
          const run = await page.request
            .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } })
            .then((response) => response.json());
          expect(run.context).toEqual([
            { role: 'user', content: 'private question' },
            { role: 'assistant', content: '**正文🙂**\n' },
            { role: 'user', content: '请接着说' },
          ]);
          await expect.poll(async () => (await snapshot()).messages[3]?.status).toBe('completed');
          expect((await snapshot()).messages[2].parentId).toBe(message.id);
        }
        const copy = await page.request
          .post(`/api/conversations/${id}/duplicate`, {
            headers,
            data: { requestId: crypto.randomUUID() },
          })
          .then((r) => r.json());
        extras.push(copy.id);
        const duplicate = (await page.request
          .get(`/api/conversations/${copy.id}`)
          .then((r) => r.json())) as Snapshot;
        expect(duplicate.messages[1].generation?.failure).toEqual(failure);
        expect(duplicate.messages[1].generation?.interrupted).toBe(message.generation?.interrupted);
        const backup = await page.request
          .get(`/api/conversations/${id}/backup`)
          .then((r) => r.json());
        expect(backup.conversation.messages[1].generation.failure).toEqual(failure);
        const restoredResponse = await page.request.post('/api/backup/restore', {
          headers,
          data: backup,
        });
        expect(restoredResponse.status()).toBe(201);
        const restored = await restoredResponse.json();
        extras.push(restored.id);
        expect(restored.snapshot.messages[1].generation.failure).toEqual(failure);
        expect(restored.snapshot.messages[1].generation.interrupted).toBe(
          message.generation?.interrupted,
        );
        const settingsButton = page.getByRole('button', { name: '供应商设置', exact: true });
        if (!(await settingsButton.isVisible()))
          await page.getByTestId('provider-failure').locator('summary').click();
        await settingsButton.click();
        await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
        await expect(page.getByLabel('名称', { exact: true })).toHaveValue('错误诊断供应商');
      } finally {
        for (const conversation of [id, ...extras])
          await page.request.delete(`/api/conversations/${conversation}`, { headers });
        await page.request.put('/api/settings/providers', { headers, data: original });
      }
    });
  }
}

test('a provider model-list 401 keeps the Access session and exposes diagnostics in settings', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  try {
    const configured = await page.request.put('/api/settings/providers', {
      headers,
      data: {
        ...original,
        activeProviderId: null,
        activeModel: '',
        providers: [
          {
            id: providerId,
            name: '无效密钥供应商',
            provider: 'openai-chat',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'not-a-real-key',
            models: [],
          },
        ],
      },
    });
    expect(configured.ok()).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: '空间设置', exact: true }).click();
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await page.getByRole('button', { name: '获取', exact: true }).click();
    const failure = page.getByTestId('provider-failure');
    await expect(failure).toContainText('模型供应商拒绝访问');
    await failure.locator('summary').click();
    await expect(failure.locator('dd').filter({ hasText: /^401$/ })).toBeVisible();
    await expect(failure).toContainText('Unauthorized');
    await expect(page.getByTestId('provider-response-body')).toContainText('Unauthorized');
    expect((await page.request.get('/api/session')).ok()).toBe(true);
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  } finally {
    await page.request.put('/api/settings/providers', { headers, data: original });
  }
});
