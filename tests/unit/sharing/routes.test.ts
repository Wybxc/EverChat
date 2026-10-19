import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../../../worker/http/worker';
import { HttpError } from '../../../worker/http/response';
import type { Env } from '../../../worker/http/env';
const origin = 'https://chat.example.com',
  id = 'a'.repeat(22),
  token = 'b'.repeat(43);
test('public sharing bypasses only the private router and refuses cookies, invalid IDs, writes and cross-origin reads', async () => {
  let reads = 0,
    privateAuth = 0,
    assets = 0;
  const worker = createWorker(async () => {
    privateAuth++;
    throw new HttpError(401, '请登录。');
  });
  const env = {
    SHARES: {
      getByName: (name: string) => {
        assert.equal(name, 'personal');
        return {
          read: (given: string, secret: string) => {
            reads++;
            assert.equal(given, id);
            assert.equal(secret, token);
            return Response.json({ share: { title: '公开' } });
          },
        };
      },
    },
    ASSETS: {
      fetch: () => {
        assets++;
        return new Response('static');
      },
    },
  } as unknown as Env;
  const fetch = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  const headers = { Authorization: `Bearer ${token}` };
  for (const path of ['/api', '/api/session', '/api/shares', '/api/usage/report'])
    assert.equal((await fetch(path)).status, 401);
  assert.equal(privateAuth, 4);
  assert.equal(
    (await fetch(`/public/shares/${id}`, { headers: { Cookie: 'CF_Authorization=anything' } }))
      .status,
    404,
  );
  assert.equal((await fetch(`/public/shares/${id}?token=${token}`)).status, 404);
  assert.equal((await fetch('/public/shares/invalid', { headers })).status, 404);
  assert.equal((await fetch(`/public/shares/${id}`, { method: 'POST', headers })).status, 404);
  assert.equal(
    (
      await fetch(`/public/shares/${id}`, {
        headers: { ...headers, Origin: 'https://foreign.example' },
      })
    ).status,
    404,
  );
  assert.equal(reads, 0);
  const result = await fetch(`/public/shares/${id}`, {
    headers: { ...headers, 'If-None-Match': 'any' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await fetch(`/public/shares/${id}`, { method: 'HEAD', headers })).status, 200);
  assert.equal(reads, 2);
  assert.equal(privateAuth, 4);
  for (const path of ['/public', '/public/unknown', '/auth', '/auth/unknown'])
    assert.equal((await fetch(path)).status, 404);
  assert.equal(assets, 0);
  assert.equal((await fetch(`/s/${id}`)).status, 200);
  assert.equal(assets, 1);
});
