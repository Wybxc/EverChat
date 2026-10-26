import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../../../worker/http/worker';
import { HttpError } from '../../../worker/http/response';
import type { Env } from '../../../worker/http/env';
const origin = 'https://chat.example.com',
  id = 'a'.repeat(22);
const template =
  '<html lang="en"><title>__EVERCHAT_SHARE_TITLE__</title><div id="root" data-share-id="__EVERCHAT_SHARE_ID__" data-share-expiry="__EVERCHAT_SHARE_EXPIRY__"><!--EVERCHAT_SHARE--></div></html>';
test('public share navigation returns body without credentials, including cross-site links; management stays private', async () => {
  let reads = 0,
    auth = 0;
  const worker = createWorker(async () => {
    auth++;
    throw new HttpError(401, '请登录。');
  });
  const env = {
    ASSETS: {
      fetch: (request: Request) => {
        assert.equal(new URL(request.url).pathname, '/share.html');
        return new Response(template);
      },
    },
    SHARES: {
      getByName: (name: string) => {
        assert.equal(name, 'personal');
        return {
          document: (given: string, html: string, locale: string, head: boolean) => {
            reads++;
            assert.equal(given, id);
            assert.equal(html, template);
            assert.equal(locale, 'zh-CN');
            return new Response(head ? null : '<html><p>公开正文</p></html>', {
              headers: { 'Content-Type': 'text/html' },
            });
          },
          status: () => Response.json({ expiresAt: null }),
        };
      },
    },
  } as unknown as Env;
  const fetch = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  for (const path of ['/api', '/api/session', '/api/shares', '/api/usage/report'])
    assert.equal((await fetch(path)).status, 401);
  const response = await fetch(`/s/${id}`, {
    headers: { 'Accept-Language': 'zh-CN,en;q=0.9', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /公开正文/);
  for (const [name, value] of Object.entries({
    'Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  }))
    assert.equal(response.headers.get(name), value);
  assert.match(response.headers.get('Content-Security-Policy')!, /script-src 'self'/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const head = await fetch(`/s/${id}`, { method: 'HEAD', headers: { 'Accept-Language': 'zh-CN' } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(reads, 2);
  assert.equal(auth, 4);
  for (const path of ['/s/invalid', `/s/${id}/extra`])
    assert.equal((await fetch(path)).status, 404);
  assert.equal((await fetch(`/s/${id}`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`/public/shares/${id}`)).status, 404);
  assert.equal((await fetch(`/public/shares/${id}/status`)).status, 200);
  assert.equal(
    (await fetch(`/public/shares/${id}/status`, { headers: { Origin: 'https://elsewhere.test' } }))
      .status,
    404,
  );
});
test('missing and unavailable shares return an HTML error with no leaked content or conditional-cache bypass', async () => {
  const worker = createWorker();
  const env = {
    ASSETS: { fetch: () => new Response(template) },
    SHARES: {
      getByName: () => ({
        document: () => Response.json({ error: 'private error' }, { status: 404 }),
      }),
    },
  } as unknown as Env;
  const response = await worker.fetch(
    new Request(`${origin}/s/${id}`, { headers: { 'If-None-Match': 'old' } }),
    env,
    {} as ExecutionContext,
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type')!, /text\/html/);
  assert.doesNotMatch(await response.text(), /private error|__EVERCHAT_/);
});
