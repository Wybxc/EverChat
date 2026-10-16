import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolValidation } from '../scripts/tool-platform-runner';
import { TOOL_VALIDATION_WORKER } from '../scripts/measurements/support/validation';

test('tool platform validation refuses a different runtime or enabled counters before sending credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'everchat-validation-guard-')), original = globalThis.fetch;
  try {
    for (const condition of ['different-runtime', 'local-counters', 'generation-counters'] as const) {
      const calls: { url: string; body: unknown }[] = [], runId = crypto.randomUUID(), output = join(directory, `${condition}.json`);
      globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), body: init?.body });
        return Response.json({ kind: TOOL_VALIDATION_WORKER, version: 1, runId: condition === 'different-runtime' ? crypto.randomUUID() : runId, mockUpstreams: true,
          counters: { generation: condition === 'generation-counters', local: condition === 'local-counters' }, workload: { chunks: 120, size: 200, interval: 25 } });
      };
      await assert.rejects(runToolValidation({ url: 'http://127.0.0.1:5191', runId, password: 'private-password-that-must-not-be-sent', output, runtime: 'local', suite: 'functional' }));
      assert.deepEqual(calls, [{ url: 'http://127.0.0.1:5191/api/__validation/identity', body: undefined }]);
      const report = await readFile(output, 'utf8');
      assert.equal(JSON.parse(report).complete, false); assert.ok(!report.includes('private-password'));
    }
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('tool platform validation accepts only isolated remote URLs or explicit local loopback', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Must not contact a rejected URL'); };
  try {
    for (const url of ['https://everchat.example.com', 'https://everchat-stream-validation.example.workers.dev', 'https://everchat-tools-validation.evil.test', 'https://everchat-tools-validation.example.workers.dev/api', 'http://127.0.0.1:5191'])
      await assert.rejects(runToolValidation({ url, runId: crypto.randomUUID(), password: 'x'.repeat(32), output: '/tmp/unused-validation-report', runtime: 'cloudflare', suite: 'functional' }));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});
