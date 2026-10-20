import { expect, test, type APIRequestContext } from '@playwright/test';
import type { EverChatBackup } from '../../../shared/backup/backup';
import { messageText } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind, ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext, protocol: ProviderKind, model: string) {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: '生成信息测试',
              provider: protocol,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: model, name: model, enabled: true, reasoningSupport: 'supported' }],
            },
          ],
          activeProviderId: providerId,
          activeModel: model,
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).status(),
  ).toBe(200);
  await request.post('/api/conversations', { headers, data: { id, title: '生成信息测试' } });
  const snapshot = () =>
    request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json()) as Promise<Snapshot>;
  return {
    id,
    snapshot,
    send: () =>
      request
        .post(`/api/conversations/${id}/messages`, {
          headers,
          data: { parentId: null, requestId: crypto.randomUUID(), content: '验证元数据' },
        })
        .then((response) => response.json()) as Promise<Submission>,
    cleanup: async (extra: string[] = []) => {
      for (const conversationId of [id, ...extra])
        await request.delete(`/api/conversations/${conversationId}`, { headers });
      expect(
        (await request.put('/api/settings/providers', { headers, data: original })).status(),
      ).toBe(200);
    },
  };
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${protocol} exposes reported usage and cloud timing and preserves it through reconnect, copying and backup restore`, async ({
    page,
    browser,
  }) => {
    const fixture = await setup(page.request, protocol, `raw-${protocol}`),
      extra: string[] = [],
      second = await browser.newContext({ locale: 'zh-CN' });
    try {
      await page.goto(`/c/${fixture.id}`);
      const accepted = await fixture.send();
      await expect
        .poll(async () => (await fixture.snapshot()).messages[1]?.status)
        .toBe('completed');
      const message = (await fixture.snapshot()).messages[1],
        generation = message.generation!;
      expect(generation).toMatchObject({
        usageIsFinal: true,
        usage: {
          inputTokens: protocol === 'anthropic' ? 14 : 10,
          outputTokens: protocol === 'gemini' ? 7 : 5,
          cachedInputTokens: 4,
        },
      });
      if (protocol === 'openai-chat')
        expect(generation.diagnostics?.response).toEqual({
          id: 'fixture-response',
          model: 'fixture-actual-model',
          timestamp: 1700000000000,
        });
      expect(generation.timing!.queueMs).toBeGreaterThanOrEqual(0);
      expect(generation.timing!.firstTokenMs).toBeGreaterThanOrEqual(1500);
      expect(generation.timing!.durationMs! - generation.timing!.firstTokenMs!).toBeGreaterThan(
        1500,
      );
      const state = await page.request
        .post(`/api/__test/conversations/${fixture.id}/state`, {
          headers,
          data: { runId: accepted.runId },
        })
        .then((response) => response.json());
      expect(generation.timing!.firstTokenMs).toBe(
        state.timing.firstTokenAt - state.timing.providerStartedAt,
      );
      const info = page.getByTestId('message-generation');
      const bodyCharacters = [...messageText(message).replace(/\s/gu, '')].length,
        reasoningCharacters = [...messageText(message, 'reasoning').replace(/\s/gu, '')].length;
      await expect(page.getByTestId('generation-summary')).toBeVisible();
      await expect(
        page.getByTestId('assistant-message').locator('[data-slot="message-header"]'),
      ).not.toContainText('Tokens');
      await expect(
        page
          .getByTestId('assistant-message')
          .locator('[data-slot="message-footer"]')
          .getByTestId('generation-summary'),
      ).toBeVisible();
      await expect(page.getByTestId('generation-summary')).toContainText(`${bodyCharacters} 字`);
      await expect(page.getByTestId('generation-summary')).toContainText('Tokens');
      await expect(page.getByTestId('generation-summary')).not.toContainText('部分');
      await page
        .getByTestId('assistant-message')
        .getByRole('button', { name: '生成信息', exact: true })
        .click();
      await expect(info).toBeVisible();
      await expect(info.getByTestId('generation-bodyCharacters')).toHaveText(
        String(bodyCharacters),
      );
      await expect(info.getByTestId('generation-reasoningCharacters')).toHaveText(
        String(reasoningCharacters),
      );
      await expect(info.getByTestId('generation-totalCharacters')).toHaveText(
        String(bodyCharacters + reasoningCharacters),
      );
      await expect(info.getByTestId('generation-inputTokens')).toHaveText(
        protocol === 'anthropic' ? '14' : '10',
      );
      await expect(info.getByTestId('generation-cachedInputTokens')).toHaveText('4');
      if (protocol === 'openai-chat') {
        await expect(info.getByTestId('generation-actualModel')).toHaveText('fixture-actual-model');
        await expect(info.getByTestId('generation-responseId')).toHaveText('fixture-response');
        await expect(info.getByTestId('generation-responseTime')).toContainText('2023');
        await expect(info.getByTestId('generation-uncachedInputTokens')).toHaveText('6');
        await expect(info.getByTestId('generation-textOutputTokens')).toHaveText('3');
      }
      await expect(info.getByText('供应商报告', { exact: true })).toBeVisible();
      await page
        .getByRole('dialog', { name: '生成信息', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await expect(page.getByTestId('generation-summary')).toBeFocused();
      await page.reload();
      await page
        .getByTestId('assistant-message')
        .getByRole('button', { name: '生成信息', exact: true })
        .click();
      await expect(page.getByTestId('message-generation')).toBeVisible();
      await second.request.post('/__dev/access/login', { headers });
      expect(
        (
          await second.request
            .get(`/api/conversations/${fixture.id}`)
            .then((response) => response.json())
        ).messages[1].generation,
      ).toEqual(generation);
      const backup = (await page.request
        .get(`/api/conversations/${fixture.id}/backup`)
        .then((response) => response.json())) as EverChatBackup;
      expect(backup.conversation.messages[1].generation).toEqual(generation);
      const copy = await page.request
        .post(`/api/conversations/${fixture.id}/duplicate`, {
          headers,
          data: { requestId: crypto.randomUUID() },
        })
        .then((response) => response.json());
      extra.push(copy.id);
      expect(
        (
          await page.request
            .get(`/api/conversations/${copy.id}`)
            .then((response) => response.json())
        ).messages[1].generation,
      ).toEqual(generation);
      const response = await page.request.post('/api/backup/restore', { headers, data: backup });
      expect(response.status()).toBe(201);
      const restored = await response.json();
      extra.push(restored.id);
      expect(restored.snapshot.messages[1].generation).toEqual(generation);
      expect(restored.snapshot.messages[1].runId).toBeNull();
      await page.goto(`/c/${restored.id}`);
      await page
        .getByTestId('assistant-message')
        .getByRole('button', { name: '生成信息', exact: true })
        .click();
      await expect(page.getByTestId('generation-firstTokenMs')).toHaveText(/s$/);
      await expect(page.getByTestId('generation-bodyCharacters')).toHaveText(
        String(bodyCharacters),
      );
    } finally {
      await second.close();
      await fixture.cleanup(extra);
    }
  });
}

test('returned thoughts are shown and determine first output before the answer, while role and heartbeat frames do not', async ({
  page,
}) => {
  const fixture = await setup(page.request, 'openai-chat', 'metadata-reasoning');
  try {
    await page.goto(`/c/${fixture.id}`);
    await fixture.send();
    await expect(page.getByTestId('generation-summary')).toContainText('思考 4 字');
    await expect.poll(async () => (await fixture.snapshot()).messages[1]?.status).toBe('completed');
    const message = (await fixture.snapshot()).messages[1];
    expect(messageText(message, 'reasoning')).not.toBe('');
    expect(messageText(message)).toBe('正文后到');
    expect(message.generation?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cachedInputTokens: 4,
    });
    expect(message.generation!.timing!.firstTokenMs).toBeGreaterThanOrEqual(200);
    expect(
      message.generation!.timing!.durationMs! - message.generation!.timing!.firstTokenMs!,
    ).toBeGreaterThan(1400);
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '生成信息', exact: true })
      .click();
    await expect(page.getByTestId('generation-reasoningTokens')).toHaveText('2');
    await expect(page.getByTestId('generation-bodyCharacters')).toHaveText('4');
    await expect(page.getByTestId('generation-reasoningCharacters')).toHaveText('4');
    await expect(page.getByTestId('generation-totalCharacters')).toHaveText('8');
    await expect(page.getByTestId('message-reasoning')).toContainText(
      messageText(message, 'reasoning'),
    );
  } finally {
    await fixture.cleanup();
  }
});

test('character counts are available during a live answer and stay after cancellation', async ({
  page,
}) => {
  const fixture = await setup(page.request, 'openai-chat', 'alarm-stall');
  try {
    await page.goto(`/c/${fixture.id}`);
    const accepted = await fixture.send();
    const answer = page.getByTestId('assistant-message');
    await expect(answer).toHaveAttribute('data-status', 'running');
    await expect(answer.getByTestId('generation-summary')).toContainText('7 字 · 思考 7 字');
    await answer.getByTestId('generation-summary').click();
    await expect(page.getByTestId('generation-bodyCharacters')).toHaveText('7');
    await expect(page.getByTestId('generation-reasoningCharacters')).toHaveText('7');
    await expect(page.getByTestId('generation-totalCharacters')).toHaveText('14');
    await page.request.post(`/api/conversations/${fixture.id}/cancel`, {
      headers,
      data: { runId: accepted.runId },
    });
    await expect(answer).toHaveAttribute('data-status', 'cancelled');
    await expect(page.getByTestId('generation-totalCharacters')).toHaveText('14');
    await page
      .getByRole('dialog', { name: '生成信息', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.reload();
    await expect(answer.getByTestId('generation-summary')).toContainText('7 字 · 思考 7 字');
  } finally {
    await fixture.cleanup();
  }
});

test('missing supplier usage stays unknown and output-free failures do not fabricate a first token', async ({
  page,
}) => {
  for (const model of ['metadata-no-usage', 'metadata-no-output']) {
    const fixture = await setup(page.request, 'openai-chat', model);
    try {
      await page.goto(`/c/${fixture.id}`);
      await fixture.send();
      await expect
        .poll(async () => (await fixture.snapshot()).messages[1]?.status)
        .toBe(model === 'metadata-no-usage' ? 'completed' : 'failed');
      const generation = (await fixture.snapshot()).messages[1].generation!;
      await page
        .getByTestId('assistant-message')
        .getByRole('button', { name: '生成信息', exact: true })
        .click();
      if (model === 'metadata-no-usage') {
        expect(generation.usage).toEqual({});
        await expect(page.getByTestId('generation-summary')).not.toContainText('Tokens');
        await expect(page.getByText('供应商未返回', { exact: true })).toBeVisible();
        await expect(page.getByTestId('generation-inputTokens')).toHaveCount(0);
        await expect(page.getByTestId('generation-outputTokens')).toHaveCount(0);
        await expect(page.getByTestId('generation-bodyCharacters')).toHaveText('4');
        await expect(page.getByTestId('generation-reasoningCharacters')).toHaveText('4');
      } else {
        expect(generation.timing?.firstTokenMs).toBeUndefined();
        await expect(page.getByTestId('generation-firstTokenMs')).toHaveCount(0);
        await expect(page.getByTestId('generation-inputTokens')).toHaveText('0');
        await expect(page.getByTestId('generation-cachedInputTokens')).toHaveText('0');
        await expect(page.getByTestId('generation-totalCharacters')).toHaveText('0');
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test('cancellation retains partial reported usage and model observations; manual revisions and deletion do not reuse them', async ({
  page,
}) => {
  const fixture = await setup(page.request, 'anthropic', 'raw-anthropic');
  try {
    await page.goto(`/c/${fixture.id}`);
    const accepted = await fixture.send();
    await expect
      .poll(async () => messageText((await fixture.snapshot()).messages[1]), { intervals: [50] })
      .toBe('**正文🙂**\n');
    await page.request.post(`/api/conversations/${fixture.id}/cancel`, {
      headers,
      data: { runId: accepted.runId },
    });
    const saved = (await fixture.snapshot()).messages[1];
    expect(saved.status).toBe('cancelled');
    expect(saved.generation).toMatchObject({
      usageIsFinal: false,
      usage: { inputTokens: 14, cachedInputTokens: 4 },
    });
    expect(saved.generation!.usage.outputTokens).toBeUndefined();
    expect(saved.generation!.timing!.firstTokenMs).toBeGreaterThanOrEqual(1500);
    await expect(page.getByTestId('generation-summary')).toContainText('部分');
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '生成信息', exact: true })
      .click();
    await expect(page.getByText('部分报告', { exact: true })).toBeVisible();
    const revision = await page.request.patch(
      `/api/conversations/${fixture.id}/messages/${saved.id}`,
      { headers, data: { requestId: crypto.randomUUID(), content: '手动修改的回答' } },
    );
    expect(revision.status()).toBe(201);
    expect((await fixture.snapshot()).messages[2].generation).toBeUndefined();
    expect(
      (
        await page.request.delete(`/api/conversations/${fixture.id}/messages/${saved.id}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    expect((await fixture.snapshot()).messages[1].generation).toBeUndefined();
    const backup = (await page.request
      .get(`/api/conversations/${fixture.id}/backup`)
      .then((response) => response.json())) as EverChatBackup;
    expect(backup.conversation.messages[1].generation).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test('an interrupted DO preserves the observed first output without inventing an upstream end time', async ({
  request,
}) => {
  const fixture = await setup(request, 'openai-chat', 'alarm-stall');
  try {
    const accepted = await fixture.send();
    await expect
      .poll(async () => messageText((await fixture.snapshot()).messages[1]))
      .toBe('等待上游的正文');
    const state = await request
      .post(`/api/__test/conversations/${fixture.id}/state`, {
        headers,
        data: { runId: accepted.runId },
      })
      .then((response) => response.json());
    expect(state.timing.firstTokenAt).not.toBeNull();
    await request.post(`/api/__test/conversations/${fixture.id}/abort`, {
      headers,
      data: { runId: accepted.runId },
    });
    await expect.poll(async () => (await fixture.snapshot()).messages[1]?.status).toBe('failed');
    const generation = (await fixture.snapshot()).messages[1].generation!;
    expect(generation.timing?.firstTokenMs).toBe(
      state.timing.firstTokenAt - state.timing.providerStartedAt,
    );
    expect(generation.timing?.durationMs).toBeUndefined();
    expect(generation.usage).toEqual({});
    expect(generation.usageIsFinal).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
