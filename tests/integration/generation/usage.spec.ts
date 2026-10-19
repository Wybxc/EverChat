import { expect, test } from '@playwright/test';
import type { ProviderKind, ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import type { UsageRecord, UsageReport } from '../../../shared/usage/types';

const headers = { Origin: 'http://127.0.0.1:5174' };
test('summary calls are independent and cancellation preserves already reported partial usage', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const modelIds = ['raw-openai-chat', 'benchmark-summary-normal', 'usage-partial-cancel'];
  try {
    await request.put('/api/settings/providers', {
      headers,
      data: {
        providers: [
          {
            id: providerId,
            name: '摘要与取消供应商',
            provider: 'openai-chat',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'integration-test-key',
            models: modelIds.map((id) => ({ id, name: id, enabled: true })),
          },
        ],
        activeProviderId: providerId,
        activeModel: modelIds[0],
        systemPrompt: '',
        maxOutputTokens: null,
      },
    });
    await request.post('/api/conversations', { headers, data: { id, title: '辅助与取消记账' } });
    const snapshot = () =>
      request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
    const first = await request
      .post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: null, content: '摘要来源' },
      })
      .then((r) => r.json());
    await expect.poll(async () => (await snapshot()).messages.at(-1)?.status).toBe('completed');
    const summary = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        summaryThrough: first.assistantId,
        selection: { providerId, model: modelIds[1] },
      },
    });
    expect(summary.status(), await summary.text()).toBe(202);
    await expect
      .poll(async () => (await snapshot()).messages.find((m) => m.summary)?.status)
      .toBe('completed');
    const cancelled = await request
      .post(`/api/conversations/${id}/messages`, {
        headers,
        data: {
          requestId: crypto.randomUUID(),
          parentId: first.assistantId,
          content: '取消',
          selection: { providerId, model: modelIds[2] },
        },
      })
      .then((r) => r.json());
    await expect
      .poll(
        async () =>
          (await snapshot()).messages.find((m) => m.id === cancelled.assistantId)?.streamState
            ?.usage?.inputTokens,
      )
      .toBe(100);
    expect(
      (
        await request.post(`/api/conversations/${id}/cancel`, {
          headers,
          data: { runId: cancelled.runId },
        })
      ).ok(),
    ).toBe(true);
    const records = () =>
      request.get(`/api/usage/requests?providerId=${providerId}`).then((r) => r.json()) as Promise<{
        records: UsageRecord[];
      }>;
    await expect
      .poll(async () => (await records()).records.find((r) => r.model === modelIds[2])?.status)
      .toBe('cancelled');
    const rows = (await records()).records;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'summary')).toMatchObject({
      status: 'completed',
      answer: false,
      usageIsFinal: true,
      usage: { inputTokens: 55, outputTokens: 19 },
    });
    expect(rows.find((r) => r.model === modelIds[2])).toMatchObject({
      status: 'cancelled',
      usageIsFinal: false,
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  } finally {
    await request.delete(`/api/conversations/${id}`, { headers });
    await request.put('/api/settings/providers', { headers, data: previous });
  }
});
for (const protocol of ['openai-chat', 'anthropic', 'openai-responses', 'gemini'] as ProviderKind[])
  test(`${protocol}: actual model request is counted once and survives conversation deletion`, async ({
    request,
  }) => {
    expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
    const previous: ProviderSettings = await request
      .get('/api/settings/providers')
      .then((r) => r.json());
    const providerId = crypto.randomUUID(),
      id = crypto.randomUUID(),
      model = `raw-${protocol}`;
    try {
      expect(
        (
          await request.put('/api/settings/providers', {
            headers,
            data: {
              providers: [
                {
                  id: providerId,
                  name: '用量夹具',
                  provider: protocol,
                  baseUrl: 'https://provider.test/v1',
                  apiKey: 'integration-test-key',
                  models: [{ id: model, name: model, enabled: true }],
                },
              ],
              activeProviderId: providerId,
              activeModel: model,
              systemPrompt: '',
              maxOutputTokens: null,
            },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await request.put('/api/usage/prices', {
            headers,
            data: {
              providerId,
              model,
              currency: 'CNY',
              input: '2',
              output: '8',
              cacheRead: null,
              cacheWrite: null,
              perRequest: null,
            },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await request.post('/api/conversations', { headers, data: { id, title: '用量验证' } })
        ).status(),
      ).toBe(201);
      const input = { parentId: null, requestId: crypto.randomUUID(), content: '统计真实请求' };
      const response = await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: input,
      });
      expect(response.status()).toBe(202);
      const submitted = await response.json();
      expect(
        await request
          .post(`/api/conversations/${id}/messages`, { headers, data: input })
          .then((r) => r.json()),
      ).toEqual(submitted);
      const snapshot = () =>
        request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
      await expect.poll(async () => (await snapshot()).messages.at(-1)?.status).toBe('completed');
      const generation = (await snapshot()).messages.at(-1)!.generation!;
      const rows = () =>
        request
          .get(`/api/usage/requests?providerId=${providerId}`)
          .then((r) => r.json()) as Promise<{ records: UsageRecord[] }>;
      await expect.poll(async () => (await rows()).records[0]?.status).toBe('completed');
      const [record] = (await rows()).records;
      expect((await rows()).records).toHaveLength(1);
      expect(record).toMatchObject({
        conversationId: id,
        kind: 'chat',
        answer: true,
        providerId,
        protocol,
        usage: generation.usage,
        usageIsFinal: generation.usageIsFinal,
      });
      expect(record.cost.state).toBe('priced');
      expect(JSON.stringify(record)).not.toContain('integration-test-key');
      const report = () =>
        request
          .get(`/api/usage/report?providerId=${providerId}`)
          .then((r) => r.json()) as Promise<UsageReport>;
      expect((await report()).totals).toMatchObject({ requests: 1, answers: 1, completed: 1 });
      expect((await request.delete(`/api/conversations/${id}`, { headers })).ok()).toBe(true);
      expect((await report()).totals).toMatchObject({ requests: 1, answers: 1, completed: 1 });
    } finally {
      expect((await request.put('/api/settings/providers', { headers, data: previous })).ok()).toBe(
        true,
      );
    }
  });

test('model capability probes include reported usage, failed requests remain unknown-cost', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const providerId = crypto.randomUUID();
  try {
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: '检测夹具',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: ['probe-text', 'probe-failed'].map((id) => ({
                  id,
                  name: id,
                  enabled: true,
                })),
              },
            ],
            activeProviderId: providerId,
            activeModel: 'probe-text',
            systemPrompt: '',
            maxOutputTokens: null,
          },
        })
      ).ok(),
    ).toBe(true);
    for (const model of ['probe-text', 'probe-failed']) {
      const result = await request.post(`/api/settings/providers/${providerId}/models/test`, {
        headers,
        data: { model, capability: 'text' },
      });
      expect(result.ok()).toBe(true);
    }
    const records = () =>
      request.get(`/api/usage/requests?providerId=${providerId}`).then((r) => r.json()) as Promise<{
        records: UsageRecord[];
      }>;
    await expect
      .poll(async () => (await records()).records.filter((r) => r.status !== 'running').length)
      .toBe(2);
    expect((await records()).records.find((r) => r.model === 'probe-text')).toMatchObject({
      kind: 'probe',
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 4 },
      usageIsFinal: true,
    });
    expect((await records()).records.find((r) => r.model === 'probe-failed')).toMatchObject({
      kind: 'probe',
      status: 'failed',
      httpStatus: 401,
      usageIsFinal: false,
      cost: { amount: null, state: 'unpriced' },
    });
  } finally {
    await request.put('/api/settings/providers', { headers, data: previous });
  }
});

test('title generation is accounted independently, while instance loss never repeats a paid request', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    interrupted = crypto.randomUUID();
  try {
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: '辅助任务夹具',
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: ['raw-openai-chat', 'title-fixture-normal', 'alarm-test'].map((id) => ({
                  id,
                  name: id,
                  enabled: true,
                })),
              },
            ],
            activeProviderId: providerId,
            activeModel: 'raw-openai-chat',
            systemPrompt: '',
            maxOutputTokens: null,
            title: { automatic: false, model: { providerId, model: 'title-fixture-normal' } },
          },
        })
      ).ok(),
    ).toBe(true);
    for (const conversationId of [id, interrupted])
      expect(
        (
          await request.post('/api/conversations', {
            headers,
            data: { id: conversationId, title: '辅助记账验证' },
          })
        ).status(),
      ).toBe(201);
    await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: { parentId: null, requestId: crypto.randomUUID(), content: '标题请求验证' },
    });
    await expect
      .poll(async () =>
        request
          .get(`/api/conversations/${id}`)
          .then((r) => r.json())
          .then((r) => r.messages[1]?.status),
      )
      .toBe('completed');
    expect(
      (
        await request.post(`/api/conversations/${id}/title`, {
          headers,
          data: { requestId: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(202);
    const records = () =>
      request.get(`/api/usage/requests?providerId=${providerId}`).then((r) => r.json()) as Promise<{
        records: UsageRecord[];
      }>;
    await expect
      .poll(async () => (await records()).records.find((r) => r.kind === 'title')?.status)
      .toBe('completed');
    expect((await records()).records.find((r) => r.kind === 'title')).toMatchObject({
      model: 'title-fixture-normal',
      conversationId: id,
      usageIsFinal: false,
    });
    const sent = await request.post(`/api/conversations/${interrupted}/messages`, {
      headers,
      data: {
        parentId: null,
        requestId: crypto.randomUUID(),
        content: '中断验证',
        selection: { providerId, model: 'alarm-test' },
      },
    });
    expect(sent.status()).toBe(202);
    const run = await sent.json();
    await expect
      .poll(async () => (await records()).records.find((r) => r.taskId === run.runId)?.status)
      .toBe('running');
    try {
      await request.post(`/api/__test/conversations/${interrupted}/abort`, {
        headers,
        data: { runId: run.runId },
      });
    } catch {
      /* Deliberately aborted RPC. */
    }
    // A new client read wakes the aborted object; recovery must never reopen the supplier.
    await request.get(`/api/conversations/${interrupted}`);
    await expect
      .poll(async () => (await records()).records.find((r) => r.taskId === run.runId)?.status)
      .toBe('unknown');
    expect((await records()).records.filter((r) => r.taskId === run.runId)).toHaveLength(1);
    expect(
      await request
        .post(`/api/__test/conversations/${interrupted}/state`, {
          headers,
          data: { runId: run.runId },
        })
        .then((r) => r.json()),
    ).toMatchObject({ calls: 1 });
  } finally {
    for (const conversationId of [id, interrupted])
      await request.delete(`/api/conversations/${conversationId}`, { headers });
    await request.put('/api/settings/providers', { headers, data: previous });
  }
});
