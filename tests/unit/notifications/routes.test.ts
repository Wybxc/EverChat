import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../../../worker/http/app';
import { HttpError } from '../../../worker/http/response';
import type { Env } from '../../../worker/http/env';
import type { NotificationDevice } from '../../../shared/notifications/protocol';

test('notification endpoints reject untrusted writes before authentication and require an authenticated identity', async () => {
  let authentications = 0;
  const app = createApi(async () => {
    authentications++;
    throw new HttpError(401, '请登录。');
  });
  const url = 'https://chat.example.com/api/notifications/device';
  for (const origin of [null, 'https://other.example']) {
    const response = await app.request(url, {
      method: 'PUT',
      headers: origin ? { Origin: origin } : {},
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(authentications, 0);
  }
  for (const [path, method] of [
    ['config', 'GET'],
    ['device', 'PUT'],
    ['sync?instance=fixture', 'GET'],
  ]) {
    const response = await app.request(`https://chat.example.com/api/notifications/${path}`, {
      method,
      headers: { Origin: 'https://chat.example.com' },
    });
    assert.equal(response.status, 401);
  }
  assert.equal(authentications, 3);
});

test('subscription API normalizes omitted expiry and diagnoses invalid fields without disclosing input values', async () => {
  let saved: NotificationDevice | undefined;
  const app = createApi(async () => ({
    issuer: 'https://team.cloudflareaccess.com',
    sub: 'fixture',
    email: 'fixture@example.com',
    expires: Math.floor(Date.now() / 1000) + 3600,
  }));
  const env = {
    LIBRARY: {
      getByName: () => ({
        saveNotificationDevice: (_owner: string, device: NotificationDevice) => {
          saved = device;
          return Response.json(device);
        },
      }),
    },
  } as unknown as Env;
  const input = {
    instanceId: crypto.randomUUID(),
    revision: 1,
    mode: 'always',
    subscription: {
      endpoint: 'https://web.push.apple.com/fixture',
      keys: { auth: 'a'.repeat(22), p256dh: 'a'.repeat(87) },
    },
  };
  const send = (body: string) =>
    app.request(
      'https://chat.example.com/api/notifications/device',
      {
        method: 'PUT',
        headers: { Origin: 'https://chat.example.com', 'Content-Type': 'application/json' },
        body,
      },
      env,
    );
  assert.equal((await send(JSON.stringify(input))).status, 200);
  assert.deepEqual(saved, {
    ...input,
    subscription: { ...input.subscription, expirationTime: null },
  });
  const invalid = await send(
    JSON.stringify({
      ...input,
      subscription: { ...input.subscription, keys: { auth: 'sensitive-fixture', p256dh: 'bad' } },
    }),
  );
  assert.equal(invalid.status, 400);
  const diagnostic = (await invalid.json()) as { code: string; error: string };
  assert.equal(diagnostic.code, 'INVALID_NOTIFICATION_DEVICE');
  assert.match(diagnostic.error, /subscription.keys.auth/);
  assert.doesNotMatch(diagnostic.error, /sensitive-fixture/);
  assert.equal((await send('{malformed')).status, 400);
});

test('notification upgrades use fetch transport with verified identity and discard client credentials and forged session headers', async () => {
  const principal = {
    issuer: 'https://team.cloudflareaccess.com',
    sub: 'fixture',
    email: 'fixture@example.com',
    expires: Math.floor(Date.now() / 1000) + 3600,
  };
  const app = createApi(async () => principal);
  let forwarded: Request | undefined;
  const env = {
    LIBRARY: {
      getByName: () => ({
        fetch: (request: Request) => {
          forwarded = request;
          return new Response('fetch transport');
        },
      }),
    },
  } as unknown as Env;
  const response = await app.request(
    'https://chat.example.com/api/notifications/sync?instance=fixture',
    {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://chat.example.com',
        Cookie: 'sensitive-fixture',
        'Cf-Access-Jwt-Assertion': 'sensitive-fixture',
        'X-Notification-Owner': 'forged',
        'X-Session-Expires': '9999999999',
      },
    },
    env,
  );
  assert.equal(await response.text(), 'fetch transport');
  assert.ok(forwarded);
  assert.equal(forwarded.url, 'https://chat.example.com/api/notifications/sync?instance=fixture');
  assert.equal(forwarded.headers.get('Upgrade'), 'websocket');
  assert.equal(
    forwarded.headers.get('X-Notification-Owner'),
    JSON.stringify([principal.issuer, principal.sub]),
  );
  assert.equal(forwarded.headers.get('X-Session-Expires'), String(principal.expires));
  assert.equal(forwarded.headers.get('Cookie'), null);
  assert.equal(forwarded.headers.get('Cf-Access-Jwt-Assertion'), null);
  forwarded = undefined;
  const foreign = await app.request(
    'https://chat.example.com/api/notifications/sync?instance=fixture',
    { headers: { Upgrade: 'websocket', Origin: 'https://other.example' } },
    env,
  );
  assert.equal(foreign.status, 403);
  assert.equal(forwarded, undefined);
});
