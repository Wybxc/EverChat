import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api';

test('non-JSON platform failures become a retryable API failure without exposing the raw page', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html>private platform diagnostic</html>', { status: 503 });
    await assert.rejects(api('/conversations/test'), (error: unknown) => error instanceof ApiError && error.status === 503 && !error.message.includes('private'));
    globalThis.fetch = async () => Response.json({ error: '云端存储额度不足' }, { status: 507 });
    await assert.rejects(api('/conversations/test'), (error: unknown) => error instanceof ApiError && error.status === 507 && error.message === '云端存储额度不足');
  } finally { globalThis.fetch = original; }
});
