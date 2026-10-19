import { jwtVerify } from 'jose';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  NOTIFICATION_CHANNEL,
  type AnswerCompletion,
  type NotificationDevice,
} from '../../shared/notifications/protocol';
import { decryptWebPush } from '../../tests/support/notifications/decrypt';
import { measurementApi, writeReport } from './support/client';
import type { ToolResourceWindow } from './support/resources';
const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'transport' },
    runtime: { type: 'string', default: 'cloudflare' },
    url: { type: 'string' },
    secrets: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-notifications.json' },
    samples: { type: 'string', default: '5' },
  },
});
assert.ok(['transport', 'pipeline'].includes(values.suite!), 'Unknown notification suite');
assert.ok(['local', 'cloudflare'].includes(values.runtime!), 'Unknown runtime');
assert.ok(values.url && values.secrets, '--url and --secrets are required');
const workerName =
  values.suite === 'pipeline'
    ? 'everchat-notification-pipeline-validation'
    : 'everchat-notifications-validation';
const url = new URL(values.url);
const local = values.runtime === 'local';
assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
assert.ok(
  local
    ? url.origin === 'http://127.0.0.1:5182'
    : url.protocol === 'https:' &&
        url.hostname.startsWith(workerName + '.') &&
        url.hostname.endsWith('.workers.dev') &&
        !url.port,
  'Use only the selected isolated notification fixture',
);
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
const secret = JSON.parse(await readFile(values.secrets, 'utf8')) as {
  VALIDATION_SECRET: string;
  VAPID_PUBLIC_KEY: string;
};
assert.ok(secret.VALIDATION_SECRET);
const { api } = measurementApi({
  origin: url.origin,
  prefix: values.suite === 'transport' ? '/api/__validation/notifications/' : '',
  headers: () => ({ Authorization: 'Bearer ' + secret.VALIDATION_SECRET }),
});
const call = api;
if (values.suite === 'transport') {
  assert.ok(secret.VAPID_PUBLIC_KEY);
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
      await jwtVerify(token, verificationKey, {
        algorithms: ['ES256'],
        audience: `https://${host}`,
      });
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
    runtime: local ? 'local' : 'cloudflare',
    startedAt,
    finishedAt: new Date().toISOString(),
    complete: true,
    baselineRequests: samples,
    encryptionRequests: results.length,
    results,
    scope:
      'Production sendWebPush and Web Crypto in the selected Worker runtime. Isolated ephemeral keys and mock gateway; no production data, real push delivery, DOs, SQL, R2 or AI requests. Independent Node RFC 8291 decryption and VAPID verification. serverElapsedMs is wall time, not CPU. Local execution is not platform cost evidence; use sanitized platform tail/analytics for deployed CPU. This does not measure full Library Alarm overhead or device acceptance.',
  };
  await writeReport(values.output!, report);
  console.log(
    JSON.stringify({ workerName, complete: true, verified: results.length, output: values.output }),
  );
} else {
  type Report = {
    producer: { report: ToolResourceWindow; pending: number; databaseBytes: number };
    library: {
      report: ToolResourceWindow;
      pushes: number;
      deliveries: { done: number; count: number }[];
      alarmAt: number | null;
      databaseBytes: number;
    };
  };
  assert.equal(
    (await fetch(url.origin + '/identity', { signal: AbortSignal.timeout(30000) })).status,
    401,
  );
  assert.deepEqual(await call('/identity'), { kind: workerName, mockGateway: true });
  const results: { devices: number; startedAt: string; finishedAt: string; report: Report }[] = [];
  const startedAt = new Date().toISOString();
  const caseIds: string[] = [];
  let finishedAt = '';
  try {
    for (const count of [0, 1, 9]) {
      const caseId = crypto.randomUUID(),
        windowId = crypto.randomUUID();
      caseIds.push(caseId);
      const devices: NotificationDevice[] = Array.from({ length: count }, () => {
        const receiver = createECDH('prime256v1');
        receiver.generateKeys();
        return {
          instanceId: crypto.randomUUID(),
          revision: 1,
          mode: 'always',
          subscription: {
            endpoint: `https://web.push.apple.com/${workerName}/${crypto.randomUUID()}`,
            expirationTime: null,
            keys: {
              auth: randomBytes(16).toString('base64url'),
              p256dh: receiver.getPublicKey().toString('base64url'),
            },
          },
        };
      });
      await call('/prepare', { caseId, windowId, devices });
      const caseStart = new Date().toISOString();
      await call('/start', {
        caseId,
        completion: {
          conversationId: caseId,
          messageId: crypto.randomUUID(),
          completedAt: Date.now(),
        },
      });
      let report!: Report;
      for (let attempt = 0; attempt < 30; attempt++) {
        report = await call<Report>(`/report?case=${caseId}`);
        assert.equal(report.producer.report?.windowId, windowId, 'Producer measurement was reset');
        assert.equal(report.library.report?.windowId, windowId, 'Library measurement was reset');
        if (
          report.producer.pending === 0 &&
          report.library.pushes === count &&
          !report.library.deliveries.some((row) => row.done === 0)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(report.producer.pending, 0);
      assert.equal(report.library.pushes, count);
      assert.deepEqual(report.library.deliveries, count ? [{ done: 1, count }] : []);
      results.push({
        devices: count,
        startedAt: caseStart,
        finishedAt: new Date().toISOString(),
        report,
      });
    }
    finishedAt = new Date().toISOString();
  } finally {
    for (const caseId of caseIds) {
      const cleanup = await call<{
        producer: { alarmAt: number | null };
        library: { alarmAt: number | null };
      }>('/cleanup', { caseId });
      assert.equal(cleanup.producer.alarmAt, null);
      assert.equal(cleanup.library.alarmAt, null);
    }
  }
  const output = {
    workerName,
    runtime: local ? 'local' : 'cloudflare',
    startedAt,
    finishedAt,
    complete: true,
    cases: results,
    cleanup: { cases: caseIds.length, deleteAllCompleted: true, alarmsCleared: true },
    scope:
      'Production outbox and Library notification pipeline with real Alarms/RPC/SQL/encryption; mock gateway. No chat generation, focus WebSockets or retries. Native cursor counters exclude preparation and observer SQL; platform CPU includes setup and report requests.',
  };
  await writeReport(values.output!, output);
  console.log(
    JSON.stringify({
      runtime: output.runtime,
      cases: results.map(({ devices }) => devices),
      complete: true,
    }),
  );
}
