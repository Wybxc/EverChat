import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchProviderModels } from '../../../worker/providers/models';

const profileId = '00000000-0000-4000-8000-000000000012';

const settings = {
  providers: [{ id: profileId, name: 'Test', provider: 'openai-chat' as const, baseUrl: 'https://provider.example/v1', models: [{ id: 'test-model', name: '测试模型', enabled: true }], apiKey: 'private-key' }],
  activeProviderId: profileId, activeModel: 'test-model', systemPrompt: 'system', maxOutputTokens: 128, showReasoning: false,
};

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${provider} fetches and normalizes its authenticated model list`, async (t) => {
    const profile = { ...settings.providers[0], provider, apiKey: 'private-key' };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      assert.equal(init?.redirect, 'manual');
      assert.equal(url.pathname, '/v1/models');
      if (provider === 'anthropic') {
        assert.equal(headers.get('x-api-key'), 'private-key'); assert.equal(headers.get('anthropic-version'), '2023-06-01');
        return Response.json({ data: [{ id: 'claude-sonnet' }, { id: 'claude-haiku' }] });
      }
      if (provider === 'gemini') {
        assert.equal(headers.get('x-goog-api-key'), 'private-key'); assert.equal(url.searchParams.get('pageSize'), '1000');
        return Response.json({ models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        ] });
      }
      assert.equal(headers.get('authorization'), 'Bearer private-key');
      return Response.json({ data: [{ id: 'gpt-z' }, { id: 'gpt-a' }, { id: 'gpt-z' }] });
    });
    const models = await fetchProviderModels(profile);
    const ids = provider === 'anthropic' ? ['claude-haiku', 'claude-sonnet'] : provider === 'gemini' ? ['gemini-2.5-flash'] : ['gpt-a', 'gpt-z'];
    assert.deepEqual(models, ids.map((id) => ({ id, name: id })));
  });
}

test('model discovery sanitizes upstream errors and requires a stored key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'private-key diagnostics' } }, { status: 401 }));
  await assert.rejects(() => fetchProviderModels(settings.providers[0]), (error: Error) => error.message.includes('401') && !error.message.includes('private-key'));
  await assert.rejects(() => fetchProviderModels({ ...settings.providers[0], apiKey: undefined }), /API 密钥/);
});
