import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { NotificationDevice } from '../../shared/notifications/protocol';
import type { ToolResourceWindow } from './support/resources';

const workerName = 'everchat-notification-pipeline-validation';
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    secrets: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-notification-pipeline.json' },
  },
});
assert.ok(values.url && values.secrets, '--url and --secrets are required');
const url = new URL(values.url);
const local = url.origin === 'http://127.0.0.1:5182';
assert.ok(
  local ||
    (url.protocol === 'https:' &&
      url.hostname.startsWith(`${workerName}.`) &&
      url.hostname.endsWith('.workers.dev') &&
      !url.port &&
      !url.username &&
      !url.password),
);
const secret = JSON.parse(await readFile(values.secrets, 'utf8')) as { VALIDATION_SECRET: string };
assert.ok(secret.VALIDATION_SECRET);
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(url.origin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${secret.VALIDATION_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Validation HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
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
await writeFile(values.output!, JSON.stringify(output, null, 2) + '\n');
console.log(
  JSON.stringify({
    runtime: output.runtime,
    cases: results.map(({ devices }) => devices),
    complete: true,
  }),
);
