import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { createAccessVerifier, authenticateAccess } from '../../../worker/http/auth';
import { HttpError } from '../../../worker/http/response';
import type { Env } from '../../../worker/http/env';
import { authReturnTo } from '../../../shared/auth/navigation';
import { validSubscription, type Attachment } from '../../../worker/streaming/subscribers';

const keys = await generateKeyPair('RS256');
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'one', alg: 'RS256' };
const origin = 'https://chat.example.com';
const issuer = 'https://team.cloudflareaccess.com';
const env = {} as Env;
const verifier = (emails = ['owner@example.com'], serviceIds?: string[]) =>
  createAccessVerifier({
    origin,
    issuer,
    audience: 'everchat-aud',
    emails,
    serviceIds,
    jwks: createLocalJWKSet({ keys: [publicKey] }),
  });
async function token(claims: JWTPayload = {}, privateKey = keys.privateKey) {
  return new SignJWT({ type: 'app', email: 'owner@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'one' })
    .setIssuer(issuer)
    .setAudience('everchat-aud')
    .setSubject('owner')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
const request = (value: string, url = origin) =>
  new Request(`${url}/api/session`, { headers: { 'Cf-Access-Jwt-Assertion': value } });
const status = (expected: number) => (error: unknown) =>
  error instanceof HttpError && error.status === expected;

test('Access verifies signed application identity and fixed origin; old cookies and identity headers cannot authenticate', async () => {
  const verify = verifier();
  const signed = await token();
  assert.equal((await verify(request(signed), env)).sub, 'owner');
  await assert.rejects(verify(request(signed, 'https://alternate.example.com'), env), status(403));
  await assert.rejects(
    verify(
      new Request(origin, {
        headers: {
          Cookie: 'everchat_session=forged',
          'Cf-Access-Authenticated-User-Email': 'owner@example.com',
        },
      }),
      env,
    ),
    status(401),
  );
  await assert.rejects(verify(request('invalid'), env), status(401));
  await assert.rejects(
    verify(request(await token({}, (await generateKeyPair('RS256')).privateKey)), env),
    status(401),
  );
});

test('Access rejects wrong issuer, audience, algorithm, expiry, activation and non-application tokens', async () => {
  const verify = verifier();
  const base = {
    type: 'app',
    email: 'owner@example.com',
    sub: 'owner',
    iss: issuer,
    aud: 'everchat-aud',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  for (const change of [
    { iss: 'https://other.cloudflareaccess.com' },
    { aud: 'other' },
    { exp: 1 },
    { exp: undefined },
    { nbf: base.exp + 1 },
  ]) {
    const signed = await new SignJWT({ ...base, ...change })
      .setProtectedHeader({ alg: 'RS256', kid: 'one' })
      .sign(keys.privateKey);
    await assert.rejects(verify(request(signed), env), status(401));
  }
  const hmac = await new SignJWT(base)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new Uint8Array(32));
  await assert.rejects(verify(request(hmac), env), status(401));
  await assert.rejects(verify(request(await token({ type: 'org' })), env), status(403));
  await assert.rejects(
    verify(request(await token({ email: 'intruder@example.com' })), env),
    status(403),
  );
});

test('Access service identities are allowed only through an explicit isolated-entry allowlist', async () => {
  const signed = await token({ email: undefined, common_name: 'fixture-client' });
  await assert.rejects(verifier()(request(signed), env), status(403));
  assert.equal(
    (await verifier([], ['fixture-client'])(request(signed), env)).sub,
    'service:fixture-client',
  );
  await assert.rejects(verifier([], ['another-client'])(request(signed), env), status(403));
});

test('Access configuration and JWKS outages fail closed without becoming a successful session', async () => {
  await assert.rejects(authenticateAccess(request(await token()), env), status(503));
  const verify = createAccessVerifier({
    origin,
    issuer,
    audience: 'everchat-aud',
    emails: ['owner@example.com'],
    jwks: async () => {
      throw new Error('network unavailable');
    },
  });
  await assert.rejects(verify(request(await token()), env), status(503));
});

test('Access reauthentication redirects remain in the application and reject open redirects and loops', () => {
  for (const value of [
    'https://evil.invalid',
    '//evil.invalid',
    '/\\evil.invalid',
    '/auth/resume',
    '/cdn-cgi/access/logout',
    '/__dev/access/login',
  ])
    assert.equal(authReturnTo(value, origin), '/');
  assert.equal(authReturnTo('/c/123?branch=abc#message', origin), '/c/123?branch=abc#message');
});

test('subscriber leases stop expired or malformed subscriptions and distinguish revalidation', () => {
  const closed: number[] = [];
  const socket = { close: (code: number) => closed.push(code) } as unknown as WebSocket;
  const now = Date.now() / 1000;
  assert.equal(validSubscription(socket, { expires: now + 600, revalidate: now + 300 }), true);
  assert.equal(validSubscription(socket, { expires: now - 1, revalidate: now - 1 }), false);
  assert.equal(validSubscription(socket, { expires: now + 600, revalidate: now - 1 }), false);
  assert.equal(validSubscription(socket, { expires: NaN } as Attachment), false);
  assert.deepEqual(closed, [4001, 4004, 4001]);
});

test('Access reuses per-request verification, refreshes rotated JWKS and retains a warm key during an outage', async () => {
  const next = await generateKeyPair('RS256');
  const rotated = { ...(await exportJWK(next.publicKey)), kid: 'two', alg: 'RS256' };
  let calls = 0,
    outage = false,
    published = [publicKey];
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    cooldownDuration: 0,
    [customFetch]: async () => {
      calls++;
      if (outage) throw new Error('JWKS offline');
      return Response.json({ keys: published });
    },
  });
  const verify = createAccessVerifier({
    origin,
    issuer,
    audience: 'everchat-aud',
    emails: ['owner@example.com'],
    jwks,
  });
  const initial = request(await token());
  await Promise.all([verify(initial, env), verify(initial, env)]);
  assert.equal(calls, 1);
  published = [publicKey, rotated];
  const signed = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'two' })
    .setIssuer(issuer)
    .setAudience('everchat-aud')
    .setSubject('owner')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(next.privateKey);
  assert.equal((await verify(request(signed), env)).sub, 'owner');
  assert.equal(calls, 2);
  outage = true;
  assert.equal((await verify(request(signed), env)).sub, 'owner');
  assert.equal(calls, 2);
  const unknown = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'unknown' })
    .setIssuer(issuer)
    .setAudience('everchat-aud')
    .setSubject('owner')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(next.privateKey);
  await assert.rejects(verify(request(unknown), env), status(503));
});
