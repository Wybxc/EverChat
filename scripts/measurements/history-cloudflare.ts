import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { messageText } from '../../shared/conversation/content';
import type { Snapshot } from '../../shared/streaming/protocol';
import { measurementApi, subscribe, until, writeReport } from './support/client';
import { measurementAccess } from './support/credentials';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    credentials: { type: 'string' },
    source: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-history-cloudflare.json' },
  },
});
assert.ok(values.url && values.credentials, '--url and --credentials are required');
const url = new URL(values.url);
assert.equal(url.protocol, 'https:');
assert.ok(
  url.hostname === 'everchat-stream-validation.wybxc.cc',
  'Use only the isolated validation Worker',
);
const origin = url.origin;
const access = await measurementAccess(values.credentials, origin);
const agent = new Agent({ proxyEnv: process.env });
const sockets = new Set<WebSocket>();

const { api, request } = measurementApi({ origin, headers: () => access.headers, timeout: 60_000 });
type Seed = {
  messages: number;
  contentCharacters: number;
  reasoningCharacters: number;
  databaseBytes: number;
};
type History = { pairs: number; conversationId: string; seed: Seed };
function validate(snapshot: Snapshot, history: History) {
  assert.equal(snapshot.seq, 501);
  assert.equal(snapshot.messages.length, history.seed.messages);
  for (const [index, message] of snapshot.messages.entries()) {
    assert.equal(message.status, 'completed');
    assert.equal(message.createdAt, index);
    assert.equal(messageText(message), index % 2 ? '正文🙂'.repeat(22500) : '历史🙂'.repeat(4000));
    assert.equal(messageText(message, 'reasoning'), index % 2 ? '思考🙂'.repeat(22500) : '');
    if (index % 2) assert.equal(message.parentId, snapshot.messages[index - 1].id);
  }
}
async function replay(history: History, snapshot?: Snapshot) {
  const began = Date.now();
  const baseline = snapshot ?? { messages: [], seq: 0 };
  const live = await subscribe({
    origin,
    id: history.conversationId,
    baseline,
    headers: access.headers,
    sockets,
    agent,
    maxPayload: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  try {
    live.check();
    validate(live.sync.durable, history);
    if (snapshot) assert.deepEqual(live.sync.durable, snapshot);
    live.socket.close(1000);
    await until(() => live.closed(), 'Clean replay close', 5000, 25);
    return {
      passed: true,
      frames: live.observed.frames,
      bytes: live.observed.bytes,
      elapsedMs: Date.now() - began,
    };
  } finally {
    live.socket.terminate();
  }
}
const startedAt = new Date().toISOString(),
  results: Record<string, unknown>[] = [];
try {
  let histories: History[] = [];
  if (values.source) {
    const source = JSON.parse(await readFile(values.source, 'utf8')) as {
      workerName: string;
      complete: boolean;
      results: History[];
    };
    assert.equal(source.workerName, 'everchat-stream-validation');
    assert.equal(source.complete, true);
    histories = source.results.map(({ pairs, conversationId, seed }) => ({
      pairs,
      conversationId,
      seed,
    }));
    assert.deepEqual(
      histories.map(({ pairs }) => pairs),
      [1, 4, 16],
    );
  } else {
    for (const pairs of [1, 4, 16]) {
      const conversationId = crypto.randomUUID();
      await api('/conversations', { id: conversationId, title: `History ${pairs} pairs` });
      const seed = await api<Seed>(`/__test/conversations/${conversationId}/history`, { pairs });
      histories.push({ pairs, conversationId, seed });
    }
  }
  for (const history of histories) {
    const reads: Record<string, unknown>[] = [];
    let snapshot: Snapshot | undefined;
    for (let index = 0; index < 5; index++) {
      const began = Date.now();
      try {
        const response = await request(`/conversations/${history.conversationId}`),
          text = await response.text();
        const bytes = Buffer.byteLength(text);
        let passed = response.status === 200;
        if (passed) {
          snapshot = JSON.parse(text) as Snapshot;
          validate(snapshot, history);
          assert.match(response.headers.get('content-type') ?? '', /application\/json/);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        }
        reads.push({ status: response.status, passed, bytes, elapsedMs: Date.now() - began });
      } catch (error) {
        reads.push({
          passed: false,
          failure: error instanceof Error ? error.name : 'UnknownError',
          elapsedMs: Date.now() - began,
        });
      }
    }
    const replays: Record<string, unknown>[] = [];
    for (const initial of [undefined, snapshot]) {
      if (initial === undefined && replays.length) continue;
      try {
        replays.push({
          mode: initial ? 'latest-cursor' : 'full-snapshot',
          ...(await replay(history, initial)),
        });
      } catch (error) {
        replays.push({
          mode: initial ? 'latest-cursor' : 'full-snapshot',
          passed: false,
          failure: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    results.push({ scenario: `history-${history.pairs}-pairs`, ...history, reads, replays });
    console.log(
      JSON.stringify({
        pairs: history.pairs,
        httpPassed: reads.filter(({ passed }) => passed).length,
        replayPassed: replays.filter(({ passed }) => passed).length,
      }),
    );
  }
} finally {
  for (const socket of sockets) socket.terminate();
  agent.destroy();
  const complete = results.length === 3;
  const passed =
    complete &&
    results.every((result) =>
      [
        ...(result.reads as { passed: boolean }[]),
        ...(result.replays as { passed: boolean }[]),
      ].every((item) => item.passed),
    );
  const output = resolve(values.output!);
  await writeReport(output, {
    version: 1,
    workerName: 'everchat-stream-validation',
    plan: 'Workers Free (user confirmed)',
    diagnosticCounters: false,
    suite: 'history',
    expectedScenarios: 3,
    complete,
    passed,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    scope:
      'Synthetic persisted completed history with compacted events. Five HTTP reads and full/latest WebSocket recovery. No suppliers, production data or configuration changes. Complete means all sizes exercised; passed separately records correctness.',
  });
  if (!passed) process.exitCode = 1;
}
