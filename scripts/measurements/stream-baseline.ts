import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { messageText } from '../../shared/conversation/content';
import type { GenerationMeasurements } from '../../shared/streaming/metrics';
import { type Snapshot } from '../../shared/streaming/protocol';
import { startLocalRuntime } from '../lib/runtime';
import { measurementApi, subscribe, writeReport } from './support/client';

const { values } = parseArgs({
  options: {
    chunks: { type: 'string', default: '120' },
    interval: { type: 'string', default: '25' },
    size: { type: 'string', default: '200' },
    port: { type: 'string', default: '5184' },
    output: { type: 'string', default: join(tmpdir(), 'everchat-stream-measurements.json') },
  },
});
const integer = (value: string | undefined, min: number, max: number) => {
  const number = Number(value);
  assert.ok(
    Number.isInteger(number) && number >= min && number <= max,
    `Expected integer in ${min}..${max}`,
  );
  return number;
};
const chunks = integer(values.chunks, 1, 1000),
  interval = integer(values.interval, 1, 500);
const size = integer(values.size, 4, 2000),
  port = integer(values.port, 1024, 65535);
const origin = `http://127.0.0.1:${port}`;
const runtime = await startLocalRuntime({
  name: 'stream-baseline',
  port,
  env: { EVERCHAT_MOCK_PROVIDER: '1', EVERCHAT_GENERATION_METRICS: '1' },
});
const sockets = new Set<WebSocket>();
let cookie = '';

const { api } = measurementApi({ origin, headers: () => ({ Cookie: cookie }), timeout: 10_000 });

async function subscriber(id: string, disconnect: boolean) {
  return subscribe({
    origin,
    id,
    baseline: await api<Snapshot>(`/conversations/${id}`),
    headers: { Cookie: cookie },
    sockets,
    disconnect,
    timeout: 10_000,
  });
}

try {
  await runtime.ready();
  assert.equal(
    (await fetch(`${origin}/api/conversations/${crypto.randomUUID()}/measurements`)).status,
    401,
    'Enabled diagnostic endpoints require authentication',
  );
  const login = await fetch(`${origin}/__dev/access/login`, {
    method: 'POST',
    headers: { Origin: origin },
    redirect: 'error',
  });
  assert.ok(login.ok, `Local signed identity: HTTP ${login.status}`);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const providerId = crypto.randomUUID();
  const scenarios = [
    { name: 'online-text', kind: 'text', size, disconnect: false },
    { name: 'online-reasoning', kind: 'reasoning', size, disconnect: false },
    {
      name: 'disconnected-long',
      kind: 'long',
      size: Math.min(size * 4, Math.floor(90_000 / chunks)),
      disconnect: true,
    },
  ];
  const models = scenarios.map((scenario) => ({
    id: `benchmark-${scenario.kind}-${chunks}-${interval}-${scenario.size}`,
    name: scenario.name,
    enabled: true,
    reasoningSupport: 'supported',
  }));
  await api(
    '/settings/providers',
    {
      providers: [
        {
          id: providerId,
          name: 'Isolated benchmark fixture',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models,
        },
      ],
      activeProviderId: providerId,
      activeModel: models[0].id,
      systemPrompt: '',
      maxOutputTokens: null,
    },
    'PUT',
  );
  const results: {
    scenario: string;
    measurements: GenerationMeasurements;
    client: { frames: number; bytes: number; disconnected: boolean };
  }[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const id = crypto.randomUUID();
    await api('/conversations', { id, title: scenario.name });
    const live = await subscriber(id, scenario.disconnect);
    const { socket, observed } = live;
    const submission = await api<{ runId: string }>(`/conversations/${id}/messages`, {
      parentId: null,
      requestId: crypto.randomUUID(),
      content: 'Deterministic stream workload',
      selection: { providerId, model: models[index].id },
    });
    const deadline = Date.now() + chunks * interval + 30_000;
    let report: GenerationMeasurements | null;
    do {
      await pause(500);
      live.snapshot();
      report = await api<GenerationMeasurements | null>(`/conversations/${id}/measurements`);
      assert.ok(Date.now() < deadline, `${scenario.name}: generation timed out`);
    } while (!report || report.runId !== submission.runId);
    assert.equal(report.status, 'completed');
    assert.equal(
      report.coverage,
      'claim-to-terminal',
      'Runtime reset made the measurement window incomplete',
    );
    assert.equal(report.textDeltas, chunks);
    assert.equal(report.reasoningDeltas, scenario.kind === 'reasoning' ? chunks : 0);
    const snapshot = await api<Snapshot>(`/conversations/${id}`);
    const answer = snapshot.messages.find(
      (message) => message.runId === submission.runId && message.role === 'assistant',
    )!;
    assert.equal(answer.status, 'completed');
    assert.equal(
      messageText(answer).length,
      chunks * Math.min(scenario.size, Math.floor(90_000 / chunks)),
    );
    assert.equal(
      messageText(answer, 'reasoning').length,
      scenario.kind === 'reasoning' ? messageText(answer).length : 0,
    );
    if (scenario.disconnect) {
      assert.ok(observed.disconnected, 'The subscriber must disconnect during generation');
      assert.ok(
        report.broadcastFrames > 0,
        'The subscriber must receive part of the answer before disconnecting',
      );
    } else {
      assert.ok(observed.bytes > 0 && report.broadcastFrames > 0);
      const syncDeadline = Date.now() + 5000;
      while (live.snapshot().seq < snapshot.seq) {
        assert.ok(
          Date.now() < syncDeadline,
          'Subscriber did not receive the final committed state',
        );
        await pause(10);
      }
      assert.deepEqual(
        live.snapshot(),
        snapshot,
        'Incremental subscriber and persisted snapshot must agree',
      );
    }
    socket.close();
    sockets.delete(socket);
    results.push({ scenario: scenario.name, measurements: report, client: observed });
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        checkpoints: report.checkpoints,
        sqlRowsWritten: report.sqlRowsWritten,
        eventPayloadBytes: report.eventPayloadBytes,
        broadcastBytes: report.broadcastBytes,
        databaseBytes: report.databaseBytes,
      }),
    );
  }
  const output = resolve(values.output!);
  await writeReport(output, {
    version: 2,
    runtime: 'local Cloudflare fixture',
    capturedAt: new Date().toISOString(),
    workload: { chunks, intervalMs: interval, baseCharactersPerChunk: size },
    scope:
      'Claim-to-terminal Conversation SQL and broadcasts; excludes bootstrap, acceptance, Library, RPC metering, alarms and diagnostic persistence. elapsedMs is wall time, not CPU. No paid model calls.',
    results,
  });
  console.log(`Saved ${output}`);
} finally {
  for (const socket of sockets) socket.terminate();
  await runtime.stop();
}
