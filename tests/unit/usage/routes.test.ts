import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../../../worker/http/app';
import { HttpError } from '../../../worker/http/response';
import type { Env } from '../../../worker/http/env';
const origin = 'https://chat.example.com';
const principal = {
  issuer: 'https://team.cloudflareaccess.com',
  sub: 'owner',
  email: 'owner@example.com',
  expires: 2_000_000_000,
};
test('statistics and pricing remain behind authentication and same-origin mutation checks', async () => {
  let calls = 0;
  const app = createApi(async () => {
    calls++;
    throw new HttpError(401, '请登录。');
  });
  for (const path of ['prices', 'requests', 'report'])
    assert.equal((await app.request(`${origin}/api/usage/${path}`)).status, 401);
  const before = calls;
  assert.equal(
    (
      await app.request(`${origin}/api/usage/prices`, {
        method: 'PUT',
        headers: { Origin: 'https://foreign.example' },
      })
    ).status,
    403,
  );
  assert.equal(calls, before);
});
test('usage API validates ranges, currencies, rates and cursors before reaching storage', async () => {
  let reads = 0,
    writes = 0;
  const app = createApi(async () => principal);
  const env = {
    USAGE: {
      getByName: () => ({
        report: () => {
          reads++;
          return Response.json({ totals: {} });
        },
        savePrice: (input: unknown) => {
          writes++;
          return input;
        },
      }),
    },
  } as unknown as Env;
  for (const query of [
    'from=2&to=1',
    'from=NaN',
    'status=other',
    'kind=arbitrary',
    'cursor=bad',
    'timeZone=Invalid/Zone',
    'limit=0',
  ])
    assert.equal((await app.request(`${origin}/api/usage/report?${query}`, {}, env)).status, 400);
  assert.equal(reads, 0);
  assert.equal(
    (await app.request(`${origin}/api/usage/report?timeZone=Asia%2FShanghai`, {}, env)).status,
    200,
  );
  assert.equal(reads, 1);
  const price = {
    providerId: 'fixture',
    model: 'model',
    currency: 'CNY',
    input: '2',
    output: '8',
    cacheRead: null,
    cacheWrite: null,
    perRequest: null,
    source: '',
  };
  const send = (input: unknown) =>
    app.request(
      `${origin}/api/usage/prices`,
      {
        method: 'PUT',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      env,
    );
  assert.equal((await send({ ...price, input: '-1' })).status, 400);
  assert.equal((await send({ ...price, currency: '人民币' })).status, 400);
  assert.equal((await send({ ...price, apiKey: 'must-never-be-recorded' })).status, 400);
  assert.equal(writes, 0);
  assert.equal((await send(price)).status, 200);
  assert.equal(writes, 1);
});
