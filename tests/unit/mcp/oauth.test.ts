import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Env } from '../../../worker/http/env';
import { matchesRedirectUri } from '../../../worker/mcp/oauth-client';
import { McpOAuthStore } from '../../../worker/mcp/oauth-store';

test('OAuth callback matching only varies the port of a registered loopback redirect', () => {
  const registered = 'http://127.0.0.1/callback?fixed=1';
  assert.equal(
    matchesRedirectUri('http://127.0.0.1:49383/callback?fixed=1', registered, true),
    true,
  );
  for (const uri of [
    'http://127.0.0.1:49383/not-the-callback?fixed=1',
    'http://localhost:49383/callback?fixed=1',
    'http://127.0.0.1:49383/callback?fixed=2',
    'http://127.0.0.1:49383/callback?fixed=1#fragment',
    'http://example.test/callback?fixed=1',
  ])
    assert.equal(matchesRedirectUri(uri, registered, true), false);
  assert.equal(
    matchesRedirectUri('https://client.test:48476/callback', 'https://client.test/callback', false),
    false,
  );
});

test('OAuth stores hashes, expires credentials, and rechecks the current Access allowlist', (context) => {
  const values = new Map<string, unknown>();
  const revoked: string[] = [];
  const storage = {
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
      delete: (key: string) => values.delete(key),
      list: ({ prefix, limit }: { prefix: string; limit?: number }) =>
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .sort()
          .slice(0, limit ?? values.size),
    },
    sql: {
      exec: (_sql: string, principal: string) => revoked.push(principal),
    },
    transactionSync: <T>(action: () => T) => action(),
  } as unknown as DurableObjectStorage;
  const env = {
    APP_ORIGIN: 'https://everchat.test',
    ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    ACCESS_ALLOWED_EMAILS: 'owner@example.test',
  } as Env;
  const owner = {
    issuer: 'https://example.cloudflareaccess.com',
    sub: 'owner',
    email: 'owner@example.test',
  };
  const verifier = 'everchat-test-code-verifier-including-43-bytes';
  const request = {
    clientId: 'https://oauth-client.test/client.json',
    name: 'Test app',
    redirectUri: 'https://oauth-client.test/callback',
    resource: 'https://everchat.test/mcp',
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
  const store = new McpOAuthStore(storage, env);
  const startedAt = Date.now();
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const consent = store.begin(owner, request);
  assert.equal(
    store.decide({ ...owner, sub: 'another-owner' }, consent.id, consent.proof, true),
    null,
  );
  const result = store.decide(owner, consent.id, consent.proof, true);
  assert.ok(result?.code);
  assert.equal(store.decide(owner, consent.id, consent.proof, true), null);
  const tokens = store.exchange({ ...request, code: result.code, verifier });
  assert.ok(tokens);
  const principal = store.authenticate(tokens.access_token);
  assert.ok(principal);
  const persisted = JSON.stringify([...values]);
  for (const credential of [consent.proof, result.code, tokens.access_token, tokens.refresh_token])
    assert.equal(persisted.includes(credential), false);
  assert.equal(store.list(owner).length, 1);
  assert.equal(store.list({ ...owner, sub: 'another-owner' }).length, 0);

  now += 15 * 60 * 1000;
  assert.equal(store.authenticate(tokens.access_token), null);
  const refresh = { ...request, refreshToken: tokens.refresh_token };
  env.ACCESS_ALLOWED_EMAILS = 'other@example.test';
  assert.equal(store.refresh(refresh), null);
  env.ACCESS_ALLOWED_EMAILS = owner.email;
  const renewed = store.refresh(refresh);
  assert.ok(renewed);
  assert.deepEqual(store.authenticate(renewed.access_token), principal);

  now = startedAt + 30 * 24 * 60 * 60 * 1000;
  assert.equal(store.refresh({ ...refresh, refreshToken: renewed.refresh_token }), null);
  store.cleanup();
  assert.equal(values.size, 0);
  assert.deepEqual(revoked, [principal.id]);
});
