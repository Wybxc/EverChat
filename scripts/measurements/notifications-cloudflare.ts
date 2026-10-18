import assert from 'node:assert/strict';
import { createECDH, createPublicKey, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { jwtVerify } from 'jose';
import { decryptWebPush } from '../../tests/support/notifications/decrypt';
import {
  NOTIFICATION_CHANNEL,
  type AnswerCompletion,
  type NotificationDevice,
} from '../../shared/notifications/protocol';

const workerName = 'everchat-notifications-validation';
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    secrets: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-notifications-cloudflare.json' },
    samples: { type: 'string', default: '5' },
  },
});
assert.ok(values.url && values.secrets, '--url and --secrets are required');
const url = new URL(values.url);
assert.ok(
  url.protocol === 'https:' &&
    url.hostname.startsWith(`${workerName}.`) &&
    url.hostname.endsWith('.workers.dev') &&
    !url.port &&
    !url.username &&
    !url.password,
);
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
const secret = JSON.parse(await readFile(values.secrets, 'utf8')) as {
  VALIDATION_SECRET: string;
  VAPID_PUBLIC_KEY: string;
};
assert.ok(secret.VALIDATION_SECRET && secret.VAPID_PUBLIC_KEY);
const call = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${url.origin}/api/__validation/notifications/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${secret.VALIDATION_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200) {
    const detail = (await response.text()).replace(/[\w-]{22,}/g, '[redacted]').slice(0, 300);
    assert.fail(`Validation response HTTP ${response.status}: ${detail}`);
  }
  return response.json() as Promise<T>;
};
const unauthorized = await fetch(`${url.origin}/api/__validation/notifications/identity`, {
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
});
assert.equal(unauthorized.status, 401);
assert.deepEqual(await call('identity'), { kind: workerName, mockGateway: true });
const startedAt = new Date().toISOString();
for (let i = 0; i < samples; i++) assert.deepEqual(await call('noop'), { ok: true });
const receiver = createECDH('prime256v1');
receiver.generateKeys();
const auth = randomBytes(16),
  pk = Buffer.from(secret.VAPID_PUBLIC_KEY, 'base64url');
const verificationKey = createPublicKey({
  format: 'jwk',
  key: {
    kty: 'EC',
    crv: 'P-256',
    x: pk.subarray(1, 33).toString('base64url'),
    y: pk.subarray(33, 65).toString('base64url'),
  },
});
type Result = {
  status: number;
  elapsedMs: number;
  capture: { authorization: string; encoding: string; ttl: string; body: string };
};
const results: {
  service: string;
  cipherBytes: number;
  serverElapsedMs: number;
  encryptedPayloadVerified: boolean;
  vapidVerified: boolean;
}[] = [];
for (const [service, host] of [
  ['apple', 'web.push.apple.com'],
  ['fcm', 'fcm.googleapis.com'],
]) {
  for (let i = 0; i < samples; i++) {
    const completion: AnswerCompletion = {
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      completedAt: Date.now(),
    };
    const device: NotificationDevice = {
      instanceId: crypto.randomUUID(),
      revision: 1,
      mode: 'always',
      subscription: {
        endpoint: `https://${host}/everchat-notifications-validation/${crypto.randomUUID()}`,
        expirationTime: null,
        keys: {
          auth: auth.toString('base64url'),
          p256dh: receiver.getPublicKey().toString('base64url'),
        },
      },
    };
    const result = await call<Result>('encrypt', { device, completion });
    assert.equal(result.status, 201);
    assert.equal(result.capture.encoding, 'aes128gcm');
    assert.ok(Number(result.capture.ttl) > 0 && Number(result.capture.ttl) <= 3600);
    const bytes = Buffer.from(result.capture.body, 'base64');
    assert.deepEqual(JSON.parse(decryptWebPush(receiver, auth, bytes).toString()), {
      channel: NOTIFICATION_CHANNEL,
      ...completion,
    });
    const token = /\bt=([^, ]+)/.exec(result.capture.authorization)?.[1];
    assert.ok(token);
    await jwtVerify(token, verificationKey, { algorithms: ['ES256'], audience: `https://${host}` });
    results.push({
      service,
      cipherBytes: bytes.length,
      serverElapsedMs: result.elapsedMs,
      encryptedPayloadVerified: true,
      vapidVerified: true,
    });
  }
}
const report = {
  version: 1,
  workerName,
  runtime: 'cloudflare',
  startedAt,
  finishedAt: new Date().toISOString(),
  complete: true,
  baselineRequests: samples,
  encryptionRequests: results.length,
  results,
  scope:
    'Actual Cloudflare Worker running production sendWebPush and Web Crypto. Isolated ephemeral keys and mock gateway; no production data, real push delivery, DOs, SQL, R2 or AI requests. Independent Node RFC 8291 decryption and VAPID verification. serverElapsedMs is wall time, not CPU. Use sanitized platform tail/analytics for CPU; this does not measure full Library Alarm overhead or device acceptance.',
};
await writeFile(values.output!, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({ workerName, complete: true, verified: results.length, output: values.output }),
);
