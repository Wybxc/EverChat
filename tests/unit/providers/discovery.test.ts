import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchProviderModels } from '../../../worker/providers/models';

const profileId = '00000000-0000-4000-8000-000000000012';

const settings = {
  providers: [
    {
      id: profileId,
      name: 'Test',
      provider: 'openai-chat' as const,
      baseUrl: 'https://provider.example/v1',
      models: [{ id: 'test-model', name: '测试模型', enabled: true }],
      apiKey: 'private-key',
    },
  ],
  activeProviderId: profileId,
  activeModel: 'test-model',
  systemPrompt: 'system',
  maxOutputTokens: 128,
};

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${provider} fetches and normalizes its authenticated model list`, async (t) => {
    const profile = { ...settings.providers[0], provider, apiKey: 'private-key' };
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        assert.equal(init?.redirect, 'manual');
        assert.equal(url.pathname, '/v1/models');
        if (provider === 'anthropic') {
          assert.equal(headers.get('x-api-key'), 'private-key');
          assert.equal(headers.get('anthropic-version'), '2023-06-01');
          return Response.json({ data: [{ id: 'claude-sonnet' }, { id: 'claude-haiku' }] });
        }
        if (provider === 'gemini') {
          assert.equal(headers.get('x-goog-api-key'), 'private-key');
          assert.equal(url.searchParams.get('pageSize'), '1000');
          return Response.json({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
            ],
          });
        }
        assert.equal(headers.get('authorization'), 'Bearer private-key');
        return Response.json({ data: [{ id: 'gpt-z' }, { id: 'gpt-a' }, { id: 'gpt-z' }] });
      },
    );
    const models = await fetchProviderModels(profile);
    const ids =
      provider === 'anthropic'
        ? ['claude-haiku', 'claude-sonnet']
        : provider === 'gemini'
          ? ['gemini-2.5-flash']
          : ['gpt-a', 'gpt-z'];
    assert.deepEqual(
      models,
      ids.map((id) => ({ id, name: id })),
    );
  });
}

test('model discovery sanitizes upstream errors and requires a stored key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'private-key diagnostics' } }, { status: 401 }),
  );
  await assert.rejects(
    () => fetchProviderModels(settings.providers[0]),
    (error: Error) => error.message.includes('401') && !error.message.includes('private-key'),
  );
  await assert.rejects(
    () => fetchProviderModels({ ...settings.providers[0], apiKey: undefined }),
    /API 密钥/,
  );
});

test('model discovery follows more than five pages and preserves more than 200 unique models', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const page = Number(url.searchParams.get('pageToken') ?? 0);
    calls++;
    return Response.json({
      models: Array.from({ length: 100 }, (_, i) => ({ name: `models/m-${page * 100 + i}` })),
      ...(page < 11 ? { nextPageToken: String(page + 1) } : {}),
    });
  });
  const models = await fetchProviderModels({ ...settings.providers[0], provider: 'gemini' });
  assert.equal(calls, 12);
  assert.equal(models.length, 1200);
  assert.ok(models.some(({ id }) => id === 'm-1199'));
});

test('discovery accepts more than 1000 models and still rejects cursor cycles', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: Array.from({ length: 1001 }, (_, i) => ({ id: `m-${i}` })),
    }),
  );
  assert.equal((await fetchProviderModels(settings.providers[0])).length, 1001);
  mock.mock.mockImplementation(async () =>
    Response.json({ data: [{ id: 'm' }], has_more: true, last_id: 'm' }),
  );
  await assert.rejects(
    fetchProviderModels({ ...settings.providers[0], provider: 'anthropic' }),
    /游标重复/,
  );
});

test('discovery cancels oversized streamed pages before parsing them', async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(256 * 1024).fill(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(fetchProviderModels(settings.providers[0]), /大小保护/);
  assert.ok(cancelled);
});
