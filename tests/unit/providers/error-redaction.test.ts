import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Env } from '../../../worker/http/env';
import { providerConfigFromEnv } from '../../../worker/providers/config';
import { generate } from '../../support/providers/consume-stream';

const provider = providerConfigFromEnv({ AI_PROVIDER: 'openai-chat', AI_BASE_URL: 'https://provider.example/v1', AI_API_KEY: 'private-key', AI_MODEL: 'test', SYSTEM_PROMPT: 'test', MAX_OUTPUT_TOKENS: '128' } as Env);

assert.ok(provider);

test('provider 401 errors keep upstream diagnostics private', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('sensitive diagnostic private-key', { status: 401 });
    await assert.rejects(() => generate(provider, [{ role: 'user', content: '测试' }], async () => {}, new AbortController().signal), (error: Error) => error.message.includes('401') && !error.message.includes('private-key'));
  } finally { globalThis.fetch = original; }
});
