import { expect, test, type APIRequestContext } from '@playwright/test';
import { messageParts, messageText } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };

async function setup(request: APIRequestContext, model = 'alarm-test') {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const settings = (await request
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
              name: 'Alarm fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: model, name: model, enabled: true, reasoningSupport: 'supported' }],
            },
          ],
          activeProviderId: providerId,
          activeModel: model,
          systemPrompt: '',
          maxOutputTokens: null,
          showReasoning: true,
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: 'Alarm execution' } })
    ).status(),
  ).toBe(201);
  const input = {
    parentId: null,
    requestId: crypto.randomUUID(),
    content: '仅执行一次',
    showReasoning: true,
  };
  const responses = await Promise.all(
    [0, 1].map(() => request.post(`/api/conversations/${id}/messages`, { headers, data: input })),
  );
  for (const response of responses) expect(response.status()).toBe(202);
  const [response, duplicate] = responses;
  const submission = (await response.json()) as Submission;
  expect(await duplicate.json()).toEqual(submission);
  return {
    id,
    input,
    submission,
    snapshot: () =>
      request
        .get(`/api/conversations/${id}`)
        .then((response) => response.json()) as Promise<Snapshot>,
    action: (action: string) =>
      request.post(`/api/__test/conversations/${id}/${action}`, {
        headers,
        data: { runId: submission.runId },
      }),
    state: async () =>
      request
        .post(`/api/__test/conversations/${id}/state`, {
          headers,
          data: { runId: submission.runId },
        })
        .then((response) => response.json()),
    restore: async () => {
      expect((await request.put('/api/settings/providers', { headers, data: settings })).ok()).toBe(
        true,
      );
    },
  };
}

test('a live DO owns the task and Alarm re-entry cannot generate twice', async ({ request }) => {
  const fixture = await setup(request);
  try {
    await expect
      .poll(async () => messageText((await fixture.snapshot()).messages[1]).length)
      .toBeGreaterThan(0);
    expect(await fixture.state()).toMatchObject({
      executor: 'do-v1',
      calls: 1,
      cancelRequested: 0,
    });
    expect((await fixture.action('alarm')).ok()).toBe(true);
    await expect.poll(async () => (await fixture.snapshot()).messages[1].status).toBe('completed');
    const stored = await fixture.snapshot();
    expect(stored.messages[1]).toMatchObject({
      error: null,
      parts: expect.arrayContaining([{ type: 'reasoning', text: '**集成思考。**' }]),
    });
    expect((await fixture.state()).calls).toBe(1);
    expect((await fixture.action('alarm')).ok()).toBe(true);
    expect(await fixture.snapshot()).toEqual(stored);
  } finally {
    await fixture.restore();
  }
});

for (const stopping of [false, true])
  test(`resetting the native DO ${stopping ? 'during cancellation ' : ''}preserves its checkpoint and never repeats the supplier call`, async ({
    request,
  }) => {
    const fixture = await setup(request);
    try {
      await expect
        .poll(async () => messageText((await fixture.snapshot()).messages[1]).length)
        .toBeGreaterThan(0);
      const prefix = await fixture.snapshot();
      try {
        await fixture.action(stopping ? 'abort-stop' : 'abort');
      } catch {
        /* The injected abort may close its own request. */
      }
      await expect.poll(async () => (await fixture.snapshot()).messages[1].status).toBe('failed');
      const stored = await fixture.snapshot();
      expect(messageText(stored.messages[1]).startsWith(messageText(prefix.messages[1]))).toBe(
        true,
      );
      expect(messageText(stored.messages[1])).not.toContain('服务端生成完成');
      expect(stored.messages[1].error).toContain('主动重新生成');
      expect(await fixture.state()).toMatchObject({ calls: 1, cancelRequested: stopping ? 1 : 0 });
      expect((await fixture.action('alarm')).ok()).toBe(true);
      const repeated = await request.post(`/api/conversations/${fixture.id}/messages`, {
        headers,
        data: fixture.input,
      });
      expect(repeated.status()).toBe(202);
      expect(await repeated.json()).toEqual(fixture.submission);
      expect(await fixture.snapshot()).toEqual(stored);
      expect((await fixture.state()).calls).toBe(1);
    } finally {
      await fixture.restore();
    }
  });

test('cancelling an accepted task before its Alarm starts prevents all supplier calls', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    expect(
      (
        await request.post(`/api/conversations/${fixture.id}/cancel`, {
          headers,
          data: { runId: fixture.submission.runId },
        })
      ).ok(),
    ).toBe(true);
    expect((await fixture.action('alarm')).ok()).toBe(true);
    expect((await fixture.snapshot()).messages[1]).toMatchObject({
      status: 'cancelled',
      parts: messageParts('', ''),
    });
    expect(await fixture.state()).toMatchObject({
      executor: 'do-v1',
      calls: 0,
      cancelRequested: 1,
      startedAt: null,
    });
  } finally {
    await fixture.restore();
  }
});

test('a cancellation tail write failure records failure rather than a false successful stop', async ({
  request,
}) => {
  const fixture = await setup(request, 'alarm-cancel-tail-failure');
  try {
    await expect.poll(async () => (await fixture.snapshot()).messages[1].status).toBe('failed');
    const stored = await fixture.snapshot();
    expect(messageText(stored.messages[1])).not.toContain('尚未保存的尾部');
    expect(stored.messages[1].error).toContain('最近检查点');
    expect(await fixture.state()).toMatchObject({
      executor: 'do-v1',
      calls: 1,
      cancelRequested: 1,
    });
    expect((await fixture.action('alarm')).ok()).toBe(true);
    expect(await fixture.snapshot()).toEqual(stored);
  } finally {
    await fixture.restore();
  }
});

test('stopping a silent upstream aborts promptly and leaves the next task scheduled', async ({
  request,
}) => {
  const fixture = await setup(request, 'alarm-stall');
  try {
    await expect
      .poll(async () => messageText((await fixture.snapshot()).messages[1]))
      .toBe('等待上游的正文');
    const started = Date.now();
    expect(
      (
        await request.post(`/api/conversations/${fixture.id}/cancel`, {
          headers,
          data: { runId: fixture.submission.runId },
        })
      ).ok(),
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await fixture.snapshot()).messages[1]).toMatchObject({
      status: 'cancelled',
      parts: messageParts('等待上游的正文', '等待上游的思考'),
    });
    expect(await fixture.state()).toMatchObject({ calls: 1, cancelRequested: 1 });
    const next = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: {
        parentId: fixture.submission.userId,
        requestId: crypto.randomUUID(),
        content: '停止后继续',
      },
    });
    expect(next.status()).toBe(202);
    const submitted = (await next.json()) as Submission;
    await expect
      .poll(async () => messageText((await fixture.snapshot()).messages[3]), { timeout: 5000 })
      .toBe('等待上游的正文');
    expect(
      (
        await request.post(`/api/conversations/${fixture.id}/cancel`, {
          headers,
          data: { runId: submitted.runId },
        })
      ).ok(),
    ).toBe(true);
    expect((await fixture.snapshot()).messages.map((message) => message.status)).toEqual([
      'completed',
      'cancelled',
      'completed',
      'cancelled',
    ]);
  } finally {
    await fixture.restore();
  }
});

test('cancellation finalizes the last complete CR-delimited SSE event without inventing completion', async ({
  request,
}) => {
  const fixture = await setup(request, 'alarm-stall-cr');
  try {
    await expect
      .poll(async () => (await fixture.snapshot()).messages[1].durableOffset ?? 0)
      .toBeGreaterThan(0);
    expect(messageText((await fixture.snapshot()).messages[1])).toBe('');
    expect(
      (
        await request.post(`/api/conversations/${fixture.id}/cancel`, {
          headers,
          data: { runId: fixture.submission.runId },
        })
      ).ok(),
    ).toBe(true);
    expect((await fixture.snapshot()).messages[1]).toMatchObject({
      status: 'cancelled',
      generation: { usage: {} },
      parts: messageParts('等待上游的正文', '等待上游的思考'),
    });
    expect((await fixture.state()).calls).toBe(1);
  } finally {
    await fixture.restore();
  }
});
