import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosePwaFailure, safePwaError } from '../../../src/platform/pwa/diagnostics';

test('PWA diagnostics exclude credentials and full authentication URLs', () => {
  const result = safePwaError(
    new Error(
      'Failed https://team.cloudflareaccess.com/login?token=private Cookie=secret sk-testcredential eyJhbGci.payload.signature',
    ),
  );
  for (const privateValue of [
    'private',
    'secret',
    'sk-testcredential',
    'eyJhbGci',
    'cloudflareaccess',
  ])
    assert.ok(!result.includes(privateValue));
});
test('PWA failure classification needs confirmed session failure, not a generic network exception', async () => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  assert.equal(
    await diagnosePwaFailure(async () => {
      throw new TypeError('Failed to fetch');
    }),
    'unknown',
  );
  assert.equal(
    await diagnosePwaFailure(async () => new Response('', { status: 401 })),
    'authentication',
  );
  assert.equal(await diagnosePwaFailure(async () => new Response('', { status: 503 })), 'server');
  assert.equal(
    await diagnosePwaFailure(async (path) =>
      path === '/api/session'
        ? Response.json({ authenticated: true })
        : new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    ),
    'script',
  );
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  assert.equal(
    await diagnosePwaFailure(async () => {
      throw new Error('must not fetch');
    }),
    'offline',
  );
});
