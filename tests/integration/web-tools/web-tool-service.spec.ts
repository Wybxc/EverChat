import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { EverChatBackup } from '../../../shared/backup/backup';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind, ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import type { WebToolServiceSettings } from '../../../shared/web-tools/service';

const headers = { Origin: 'http://127.0.0.1:5174' };
const key = 'tvly-native-private-service-key';
type Runtime = {
  modelCalls: number;
  privatePayloads: number;
  privateStreams: number;
  state: { status: string };
  pendingNotifications: number;
  workflow: { status: string } | null;
  serviceRequests: { url: string; body: string; authDigest: string }[];
};
async function setup(
  request: APIRequestContext,
  provider: ProviderKind = 'openai-chat',
  limit = 20,
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
    model = `tools-service-${provider}`;
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Service fixture',
              provider,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: model,
                  name: model,
                  enabled: true,
                  metadataOverrides: { toolCalls: true, contextWindow: 131072 },
                },
              ],
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
  const save = async (apiKey: string | undefined = key, dailyLimit = limit) => {
    const response = await request.put('/api/settings/web-tools', {
      headers,
      data: { provider: 'tavily', dailyLimit, ...(apiKey === undefined ? {} : { apiKey }) },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json() as Promise<WebToolServiceSettings>;
  };
  // Earlier tests can legitimately consume the shared daily ledger. Set this
  // scenario's ceiling relative to the persisted count instead of clearing it.
  const baseline = service.usedToday;
  await save(key, baseline + limit);
  const ids: string[] = [];
  const create = async (fault = 'service') => {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      (
        await request.post('/api/conversations', {
          headers,
          data: { id, title: 'Real adapter fixture' },
        })
      ).status(),
    ).toBe(201);
    const input = {
      parentId: null,
      requestId: crypto.randomUUID(),
      content: '查询 Cloudflare 官方资料',
      tools: ['web_search', 'read_webpage'],
    };
    const state = () =>
      request
        .post(`/api/__test/conversations/${id}/tool-runtime`, {
          headers,
          data: { taskId: input.requestId },
        })
        .then((r) => r.json()) as Promise<Runtime>;
    expect(
      (
        await request.post(`/api/__test/conversations/${id}/tool-runtime`, {
          headers,
          data: { taskId: input.requestId, fault },
        })
      ).ok(),
    ).toBe(true);
    const submit = () =>
      request.post(`/api/conversations/${id}/messages`, { headers, data: input });
    const snapshot = () =>
      request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
    return { id, input, state, submit, snapshot };
  };
  const cleanup = async () => {
    for (const id of ids)
      expect((await request.delete(`/api/conversations/${id}`, { headers })).ok()).toBe(true);
    await save(originalKey.apiKey, service.dailyLimit);
    expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(
      true,
    );
  };
  const resetLibrary = async () => {
    expect(
      (await request.post('/api/__test/library/web-tools/reset', { headers, data: {} })).status(),
    ).toBe(503);
    // The local HTTP bridge may briefly return an HTML error while the native
    // object restarts. Wait only on a read; never repeat a mutation or tool.
    await expect
      .poll(async () => (await request.get('/api/settings/web-tools')).status())
      .toBe(200);
  };
  return {
    create,
    cleanup,
    save,
    baseline,
    resetLibrary,
    settings: () =>
      request
        .get('/api/settings/web-tools')
        .then((r) => r.json()) as Promise<WebToolServiceSettings>,
  };
}

test('service settings require authentication and same-origin writes, preserve omitted keys, and reject endpoints or invalid values', async ({
  request,
  playwright,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    for (const path of ['/api/settings/web-tools', '/api/settings/web-tools/key'])
      expect((await anonymous.get(path)).status()).toBe(401);
    expect(
      (
        await anonymous.put('/api/settings/web-tools', {
          headers,
          data: { provider: 'tavily', dailyLimit: 20, apiKey: key },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await anonymous.dispose();
  }
  const f = await setup(request);
  try {
    expect(
      (
        await request.put('/api/settings/web-tools', {
          headers: { Origin: 'https://other.example' },
          data: { provider: 'tavily', dailyLimit: 20 },
        })
      ).status(),
    ).toBe(403);
    const response = await request.get('/api/settings/web-tools');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.text()).not.toContain(key);
    expect(await response.json()).toMatchObject({ provider: 'tavily', hasApiKey: true });
    for (const data of [
      { provider: 'tavily', dailyLimit: 0 },
      { provider: 'tavily', dailyLimit: 1001 },
      { provider: 'other', dailyLimit: 20 },
      { provider: 'tavily', dailyLimit: 20, baseUrl: 'https://evil.example/' },
      { provider: 'tavily', dailyLimit: 20, apiKey: 'bad\r\nkey' },
    ]) {
      expect((await request.put('/api/settings/web-tools', { headers, data })).status()).toBe(400);
    }
    expect(
      (
        await request.put('/api/settings/web-tools', {
          headers,
          data: { provider: 'tavily', dailyLimit: 20, apiKey: 'x'.repeat(8192) },
        })
      ).status(),
    ).toBe(413);
    expect(
      (
        await request.put('/api/settings/web-tools', {
          headers,
          data: { provider: 'tavily', dailyLimit: f.baseline + 30 },
        })
      ).ok(),
    ).toBe(true);
    const revealed = await request.get('/api/settings/web-tools/key');
    expect(revealed.headers()['cache-control']).toBe('no-store');
    expect(await revealed.json()).toEqual({ apiKey: key });
    await f.resetLibrary();
    expect((await f.settings()).hasApiKey).toBe(true);
    expect(await request.get('/api/settings/web-tools/key').then((r) => r.json())).toEqual({
      apiKey: key,
    });
  } finally {
    await f.cleanup();
  }
});

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} uses the production Tavily adapter and pins its key through settings changes without an online client`, async ({
    request,
  }) => {
    const f = await setup(request, provider);
    try {
      const c = await f.create();
      const response = await c.submit();
      expect(response.status()).toBe(202);
      const accepted = (await response.json()) as Submission;
      await f.save('tvly-replacement-key', f.baseline + 30);
      await expect.poll(async () => (await c.snapshot()).messages[1]?.status).toBe('completed');
      const snapshot = await c.snapshot(),
        answer = snapshot.messages[1];
      expect(answer.tools!.calls.map((call) => call.state)).toEqual(['completed', 'completed']);
      expect(
        answer.tools!.calls.flatMap((call) =>
          call.result?.status === 'completed' ? call.result.sources.map((s) => s.url) : [],
        ),
      ).toEqual(['https://developers.cloudflare.com/', 'https://developers.cloudflare.com/']);
      expect(JSON.stringify(snapshot)).not.toMatch(
        /tvly-native|tvly-replacement|encrypted-fixture|fixture-signature/,
      );
      const state = await c.state();
      expect(state.modelCalls).toBe(2);
      expect(state.serviceRequests).toHaveLength(2);
      expect(state.serviceRequests.map((r) => r.url)).toEqual([
        'https://api.tavily.com/search',
        'https://api.tavily.com/extract',
      ]);
      const digest = createHash('sha256').update(`Bearer ${key}`).digest('hex');
      for (const call of state.serviceRequests) expect(call.authDigest).toBe(digest);
      expect((await f.settings()).usedToday).toBe(f.baseline + 2);
      const duplicate = await c.submit();
      expect(duplicate.status()).toBe(202);
      expect(await duplicate.json()).toEqual(accepted);
      expect((await c.state()).serviceRequests).toHaveLength(2);
      const backup = (await request
        .get(`/api/conversations/${c.id}/backup`)
        .then((r) => r.json())) as EverChatBackup;
      expect(JSON.stringify(backup)).not.toMatch(/tvly-native|tvly-replacement/);
      expect(backup.conversation.messages[1].tools).toEqual(answer.tools);
    } finally {
      await f.cleanup();
    }
  });

test('an exhausted daily budget stops before the next model, survives Library reset, and rejects new tasks without breaking idempotency', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', 1);
  try {
    const c = await f.create();
    expect((await c.submit()).status()).toBe(202);
    await expect.poll(async () => (await c.snapshot()).messages[1]?.status).toBe('failed');
    const answer = (await c.snapshot()).messages[1];
    expect(answer.error).toContain('每日请求上限');
    expect(answer.tools!.calls.map((call) => call.state)).toEqual(['completed', 'failed']);
    expect(await c.state()).toMatchObject({ modelCalls: 1, privatePayloads: 0, privateStreams: 0 });
    expect((await c.state()).serviceRequests).toHaveLength(1);
    await f.resetLibrary();
    expect((await f.settings()).usedToday).toBe(f.baseline + 1);
    expect((await c.submit()).status()).toBe(202);
    const rejected = await request.post(`/api/conversations/${c.id}/messages`, {
      headers,
      data: { ...c.input, requestId: crypto.randomUUID() },
    });
    expect(rejected.status()).toBe(429);
    expect((await c.snapshot()).messages).toHaveLength(2);
    expect((await c.state()).modelCalls).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test('concurrent conversations share one atomic daily ledger and cannot exceed its ceiling', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat', 1);
  try {
    const first = await f.create(),
      second = await f.create();
    const responses = await Promise.all([first.submit(), second.submit()]);
    for (const r of responses) expect(r.status()).toBe(202);
    for (const c of [first, second])
      await expect.poll(async () => (await c.snapshot()).messages[1]?.status).toBe('failed');
    expect(
      (await first.state()).serviceRequests.length + (await second.state()).serviceRequests.length,
    ).toBe(1);
    expect((await f.settings()).usedToday).toBe(f.baseline + 1);
    for (const c of [first, second]) expect((await c.state()).modelCalls).toBe(1);
  } finally {
    await f.cleanup();
  }
});

for (const status of [401, 429])
  test(`HTTP ${status} tool failures are persisted without exposing the key or retrying the service`, async ({
    request,
  }) => {
    const f = await setup(request);
    try {
      const c = await f.create(`service-${status}`);
      expect((await c.submit()).status()).toBe(202);
      await expect.poll(async () => (await c.snapshot()).messages[1]?.status).toBe('failed');
      const answer = (await c.snapshot()).messages[1];
      expect(answer.tools!.calls.map((call) => call.state)).toEqual(['failed', 'failed']);
      expect(JSON.stringify(answer)).not.toContain(key);
      expect((await c.state()).serviceRequests).toHaveLength(1);
      expect((await f.settings()).usedToday).toBe(f.baseline + 1);
      expect((await c.state()).modelCalls).toBe(1);
      await expect.poll(async () => (await c.state()).workflow?.status).toBe('complete');
      await expect
        .poll(async () => (await c.state()).pendingNotifications, { timeout: 5000 })
        .toBe(0);
    } finally {
      await f.cleanup();
    }
  });

test('clearing credentials blocks a new tool task before writing messages or calling a model', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    const c = await f.create();
    await f.save('');
    expect((await f.settings()).hasApiKey).toBe(false);
    const rejected = await c.submit();
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain('尚未配置');
    expect((await c.snapshot()).messages).toEqual([]);
    expect((await c.state()).modelCalls).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test('stopping the production service fetch aborts it, retains its attempt and never continues the model', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    const c = await f.create('service-slow'),
      response = await c.submit();
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as Submission;
    await expect.poll(async () => (await c.state()).serviceRequests.length).toBe(1);
    expect(
      (
        await request.post(`/api/conversations/${c.id}/cancel`, {
          headers,
          data: { runId: accepted.runId },
        })
      ).ok(),
    ).toBe(true);
    expect((await c.snapshot()).messages[1]).toMatchObject({
      status: 'cancelled',
      tools: { status: 'cancelled' },
    });
    await expect.poll(async () => (await c.state()).workflow?.status).toBe('complete');
    expect((await c.state()).serviceRequests).toHaveLength(1);
    expect((await f.settings()).usedToday).toBe(f.baseline + 1);
    expect((await c.state()).modelCalls).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test('a production service timeout records its attempt and stops the root before a second tool or model', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    const c = await f.create('service-timeout');
    expect((await c.submit()).status()).toBe(202);
    await expect
      .poll(async () => (await c.snapshot()).messages[1]?.status, { timeout: 30_000 })
      .toBe('failed');
    const answer = (await c.snapshot()).messages[1];
    expect(answer.error).toContain('15 秒');
    expect(answer.tools!.calls.map((call) => call.state)).toEqual(['failed', 'failed']);
    expect((await c.state()).serviceRequests).toHaveLength(1);
    expect((await c.state()).modelCalls).toBe(1);
    expect((await f.settings()).usedToday).toBe(f.baseline + 1);
  } finally {
    await f.cleanup();
  }
});

test('lowering the daily ceiling applies to an already accepted task before its external requests', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    const c = await f.create();
    expect((await c.submit()).status()).toBe(202);
    await f.save(key, f.baseline + 1);
    await expect.poll(async () => (await c.snapshot()).messages[1]?.status).toBe('failed');
    expect((await c.snapshot()).messages[1].error).toContain('每日请求上限');
    expect((await c.state()).serviceRequests).toHaveLength(1);
    expect((await c.state()).modelCalls).toBe(1);
    expect((await f.settings()).usedToday).toBe(f.baseline + 1);
  } finally {
    await f.cleanup();
  }
});

test('resetting the DO during a production fetch preserves its quota claim and resumes only the unclaimed tool', async ({
  request,
}) => {
  const f = await setup(request);
  try {
    const c = await f.create('service-slow'),
      response = await c.submit();
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as Submission;
    await expect.poll(async () => (await c.state()).serviceRequests.length).toBe(1);
    expect(
      (
        await request.post(`/api/__test/conversations/${c.id}/abort`, {
          headers,
          data: { runId: accepted.runId },
        })
      ).status(),
    ).toBe(503);
    expect(
      (
        await request.post(`/api/__test/conversations/${c.id}/tool-runtime`, {
          headers,
          data: { taskId: c.input.requestId, fault: 'service' },
        })
      ).ok(),
    ).toBe(true);
    await expect
      .poll(async () => (await c.snapshot()).messages[1]?.status, { timeout: 30_000 })
      .toBe('completed');
    expect((await c.snapshot()).messages[1].tools!.calls.map((call) => call.state)).toEqual([
      'failed',
      'completed',
    ]);
    const state = await c.state();
    expect(state.serviceRequests).toHaveLength(2);
    expect(state.modelCalls).toBe(2);
    expect(state.serviceRequests.map((r) => r.url)).toEqual([
      'https://api.tavily.com/search',
      'https://api.tavily.com/extract',
    ]);
    expect((await f.settings()).usedToday).toBe(f.baseline + 2);
  } finally {
    await f.cleanup();
  }
});
