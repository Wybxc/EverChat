import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import WebSocket from 'ws';
import { messageText } from '../../shared/conversation/content';
import type { Submission } from '../../shared/conversation/types';
import type { ModelSelection } from '../../shared/models/types';
import type { ProviderKind } from '../../shared/providers/types';
import type { Snapshot } from '../../shared/streaming/protocol';
import { measurementApi, subscribe, until, writeReport } from './support/client';
import { measurementAccess } from './support/credentials';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    credentials: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-stream-cloudflare.json' },
    suite: { type: 'string', default: 'functional' },
    scenarios: { type: 'string' },
    source: { type: 'string' },
  },
});
assert.ok(
  ['functional', 'sustained', 'reconnect'].includes(values.suite!),
  '--suite must be functional, sustained or reconnect',
);
const sustained = values.suite === 'sustained';
const reconnect = values.suite === 'reconnect';
const selectedScenarios = values.scenarios?.split(',');
assert.ok(!selectedScenarios || !reconnect, 'Scenario selection requires a generation suite');
let expectedScenarios = reconnect ? 30 : sustained ? 3 : 9;
assert.ok(values.url && values.credentials, '--url and --credentials are required');
const url = new URL(values.url);
assert.equal(url.protocol, 'https:');
assert.ok(
  url.hostname === 'everchat-stream-validation.wybxc.cc',
  'Use only the isolated validation Worker',
);
const origin = url.origin;
const access = await measurementAccess(values.credentials, origin);
// Node fetch otherwise has a separate 10s connection timeout despite the 90s request signal.
const previousDispatcher = getGlobalDispatcher();
const dispatcher = new EnvHttpProxyAgent({
  connect: { timeout: 90_000, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500 },
});
setGlobalDispatcher(dispatcher);
const sockets = new Set<WebSocket>();
// ws overrides the default connector; supply an explicit agent to honor configured proxies.
const agent = new Agent({ proxyEnv: process.env });
const { api } = measurementApi({
  origin,
  headers: () => access.headers,
  timeout: 90_000,
  readAttempts: 3,
});
async function subscriber(id: string, initial?: Snapshot, acknowledge = true) {
  const baseline = initial?.epoch ? initial : await api<Snapshot>(`/conversations/${id}`);
  const result = await subscribe({
    origin,
    id,
    baseline,
    headers: access.headers,
    sockets,
    agent,
    acknowledge,
    timeout: 90_000,
  });
  return { ...result, received: result.observed };
}

const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
let phase = 'preflight',
  currentScenario: string | undefined;
let failure: { phase: string; scenario?: string; name: string; code?: string } | undefined;
try {
  assert.equal(
    (
      await fetch(`${origin}/api/settings/providers`, {
        redirect: 'manual',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/conversations/${crypto.randomUUID()}/measurements`, {
        headers: { ...access.headers },
      })
    ).status,
    404,
    'Disable diagnostic CPU overhead for platform measurement',
  );
  if (reconnect) {
    assert.ok(values.source, '--source requires a completed sustained report');
    const source = JSON.parse(await readFile(values.source, 'utf8')) as {
      workerName: string;
      complete: boolean;
      results: { conversationId: string; contentCharacters: number; reasoningCharacters: number }[];
    };
    assert.equal(source.workerName, 'everchat-stream-validation');
    assert.equal(source.complete, true);
    const item = source.results.find((result) => result.reasoningCharacters > 0);
    assert.ok(item);
    const stored = await api<Snapshot>(`/conversations/${item.conversationId}`);
    assert.equal(stored.messages[1].status, 'completed');
    assert.equal(messageText(stored.messages[1]).length, item.contentCharacters);
    assert.equal(messageText(stored.messages[1], 'reasoning').length, item.reasoningCharacters);
    for (let index = 0; index < expectedScenarios; index++) {
      currentScenario = `reconnect-${index + 1}`;
      phase = 'completed-stream-replay';
      let live: Awaited<ReturnType<typeof subscriber>> | undefined,
        handshakeAttempts = 0;
      while (!live) {
        handshakeAttempts++;
        try {
          live = await subscriber(item.conversationId, index % 2 ? stored : undefined);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            handshakeAttempts >= 3 ||
            !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code ?? '')
          )
            throw error;
          await pause(handshakeAttempts * 1000);
        }
      }
      live.check();
      assert.deepEqual(live.sync.durable, stored);
      live.socket.close(1000);
      await until(() => live.code() !== undefined, 'clean replay close');
      assert.equal(live.code(), 1000);
      results.push({
        scenario: `reconnect-${index + 1}`,
        mode: index % 2 ? 'latest-cursor' : 'full-replay',
        status: 'completed',
        handshakeAttempts,
        client: live.received,
      });
    }
    console.log(JSON.stringify({ suite: 'reconnect', completed: results.length }));
  } else {
    const profiles = (['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map(
      (provider) => ({
        id: crypto.randomUUID(),
        name: provider,
        provider,
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        models: [
          { id: `raw-${provider}`, name: 'Raw SSE', enabled: true, reasoningSupport: 'supported' },
          ...(provider === 'openai-chat'
            ? [
                'benchmark-text-120-25-200',
                'benchmark-reasoning-120-25-200',
                'benchmark-long-120-25-750',
                'benchmark-reasoning-120-25-750',
                'benchmark-text-120-100-200',
                'benchmark-text-140-500-600',
                'benchmark-reasoning-140-500-600',
              ].map((id) => ({
                id,
                name: id,
                enabled: true,
                reasoningSupport: 'supported',
                metadataOverrides: { contextWindow: 131072 },
              }))
            : []),
        ],
      }),
    );
    let cases: {
      name: string;
      protocol: ProviderKind;
      model: string;
      mode?: 'disconnect' | 'cancel' | 'partial' | 'slow' | 'reconnect';
      characters: number;
      thoughts: number;
    }[] = sustained
      ? [
          {
            name: 'sustained-text',
            protocol: 'openai-chat',
            model: 'benchmark-text-140-500-600',
            characters: 84000,
            thoughts: 0,
          },
          {
            name: 'sustained-reasoning-reconnect',
            protocol: 'openai-chat',
            model: 'benchmark-reasoning-140-500-600',
            mode: 'reconnect',
            characters: 84000,
            thoughts: 84000,
          },
          {
            name: 'sustained-disconnected',
            protocol: 'openai-chat',
            model: 'benchmark-text-140-500-600',
            mode: 'disconnect',
            characters: 84000,
            thoughts: 0,
          },
        ]
      : [
          {
            name: 'online-text',
            protocol: 'openai-chat',
            model: 'benchmark-text-120-25-200',
            characters: 24000,
            thoughts: 0,
          },
          {
            name: 'online-reasoning',
            protocol: 'openai-chat',
            model: 'benchmark-reasoning-120-25-200',
            characters: 24000,
            thoughts: 24000,
          },
          {
            name: 'disconnected-long',
            protocol: 'openai-chat',
            model: 'benchmark-long-120-25-750',
            mode: 'disconnect',
            characters: 90000,
            thoughts: 0,
          },
          ...(['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map(
            (protocol) => ({
              name: `${protocol}-partial-resume`,
              protocol,
              model: `raw-${protocol}`,
              mode: 'partial' as const,
              characters: '**正文🙂**\n答案。'.length,
              thoughts: '**思考🙂**\n结论。'.length,
            }),
          ),
          {
            name: 'slow-subscriber',
            protocol: 'openai-chat',
            model: 'benchmark-reasoning-120-25-750',
            mode: 'slow',
            characters: 90000,
            thoughts: 90000,
          },
          {
            name: 'cancel',
            protocol: 'openai-chat',
            model: 'benchmark-text-120-100-200',
            mode: 'cancel',
            characters: 0,
            thoughts: 0,
          },
        ];
    if (selectedScenarios) {
      assert.ok(
        selectedScenarios.length > 0 &&
          new Set(selectedScenarios).size === selectedScenarios.length,
      );
      assert.ok(
        selectedScenarios.every((name) => cases.some((item) => item.name === name)),
        'Unknown scenario',
      );
      cases = cases.filter((item) => selectedScenarios.includes(item.name));
      expectedScenarios = cases.length;
    }
    phase = 'configure-mock-providers';
    await api(
      '/settings/providers',
      {
        providers: profiles,
        activeProviderId: profiles[0].id,
        activeModel: profiles[0].models[0].id,
        systemPrompt: '',
        maxOutputTokens: null,
      },
      'PUT',
    );
    for (const item of cases) {
      currentScenario = item.name;
      phase = 'create-conversation';
      const id = crypto.randomUUID(),
        begin = Date.now();
      await api('/conversations', { id, title: item.name });
      phase = 'connect-subscribers';
      let live = await subscriber(id);
      const earlierClient = { frames: 0, bytes: 0 };
      let shadow = item.name.includes('reasoning') ? await subscriber(id) : undefined;
      const slow = item.mode === 'slow' ? await subscriber(id, undefined, false) : undefined;
      const selection: ModelSelection = {
        providerId: profiles.find((profile) => profile.provider === item.protocol)!.id,
        model: item.model,
      };
      const input = {
        parentId: null,
        requestId: crypto.randomUUID(),
        content: sustained ? '长输入。'.repeat(4000) : 'Platform stream validation',
        selection,
      };
      phase = 'submit-generation';
      const accepted = await api<Submission>(`/conversations/${id}/messages`, input);
      phase = 'verify-idempotent-submission';
      assert.deepEqual(await api(`/conversations/${id}/messages`, input), accepted);
      const acceptedAt = Date.now();
      phase = 'observe-generation';
      let reconnects = 0;
      async function recoverBoundedSubscriber(
        connection: Awaited<ReturnType<typeof subscriber>>,
        countClient = true,
      ) {
        assert.ok(
          connection.recoverable(),
          'Only network or bounded-subscriber closure can resume',
        );
        connection.socket.terminate();
        if (countClient) {
          earlierClient.frames += connection.received.frames;
          earlierClient.bytes += connection.received.bytes;
          reconnects++;
        }
        return subscriber(id, connection.sync.durable);
      }
      if (item.mode === 'partial') {
        await until(() => {
          live.check();
          return messageText(live.sync.durable.messages[1] ?? { parts: [] }).length > 0;
        }, item.name);
        // Provider framing stays inside the SDK. The durable checkpoint contains
        // normalized application events, never an unfinished native SSE frame.
        const prefix = live.sync.durable.messages[1];
        assert.ok('**正文🙂**\n答案。'.startsWith(messageText(prefix)));
        assert.ok('**思考🙂**\n结论。'.startsWith(messageText(prefix, 'reasoning')));
        assert.ok(!JSON.stringify(prefix.streamState ?? {}).includes('data:'));
        live.socket.close();
        const snapshot = await api<Snapshot>(`/conversations/${id}`);
        assert.ok(snapshot.messages[1].durableOffset! >= prefix.durableOffset!);
        earlierClient.frames += live.received.frames;
        earlierClient.bytes += live.received.bytes;
        live = await subscriber(id, snapshot);
        reconnects++;
      } else if (item.mode === 'reconnect') {
        const deadline = Date.now() + 240_000;
        for (let index = 0; index < 20; index++) {
          assert.ok(Date.now() < deadline, 'Repeated reconnects: timed out');
          await pause(1500);
          if (live.recoverable()) live = await recoverBoundedSubscriber(live);
          live.check();
          if (['completed', 'failed'].includes(live.sync.durable.messages[1]?.status ?? '')) break;
          live.socket.close();
          await until(() => live.code() !== undefined, 'close before reconnect');
          const snapshot = await api<Snapshot>(`/conversations/${id}`);
          earlierClient.frames += live.received.frames;
          earlierClient.bytes += live.received.bytes;
          live = await subscriber(id, snapshot);
          reconnects++;
          assert.ok(live.sync.durable.seq >= snapshot.seq);
          assert.equal(live.sync.view.messages[1]?.runId, accepted.runId);
        }
        assert.ok(reconnects >= 2, 'Exercise repeated recovery during sustained generation');
      } else if (item.mode === 'disconnect' || item.mode === 'cancel') {
        await until(() => {
          live.check();
          return messageText(live.sync.view.messages[1]).length > 0;
        }, item.name);
        if (item.mode === 'disconnect') live.socket.close();
        else await api(`/conversations/${id}/cancel`, { runId: accepted.runId });
      }
      let stored: Snapshot;
      if (item.mode === 'disconnect') {
        await until(
          async () => {
            stored = await api<Snapshot>(`/conversations/${id}`);
            return ['completed', 'failed'].includes(stored.messages[1].status);
          },
          item.name,
          sustained ? 150000 : 30000,
          sustained ? 5000 : 100,
        );
      } else {
        await until(
          async () => {
            if (live.recoverable()) live = await recoverBoundedSubscriber(live);
            live.check();
            // High RTT can exhaust the preview window of an acknowledging
            // client too. Resume confirmed state; never restart generation.
            if (live.code() !== undefined)
              throw new Error(`Unexpected subscription close: ${live.code()}`);
            return ['completed', 'failed', 'cancelled'].includes(
              live.sync.durable.messages[1]?.status ?? '',
            );
          },
          item.name,
          sustained ? 150000 : 90000,
        );
      }
      phase = 'verify-durable-result';
      stored = await api<Snapshot>(`/conversations/${id}`);
      const answer = stored.messages[1];
      const observationElapsedMs = Date.now() - acceptedAt;
      const generationElapsedMs = answer.generation?.timing?.durationMs;
      if (sustained)
        assert.ok(
          generationElapsedMs !== undefined && generationElapsedMs >= 60000,
          `${item.name}: exercise at least one minute of generation`,
        );
      assert.equal(
        answer.status,
        item.mode === 'cancel' ? 'cancelled' : 'completed',
        `${item.name}: ${answer.error}`,
      );
      if (item.mode === 'cancel')
        assert.ok(messageText(answer).length > 0 && messageText(answer).length < 24000);
      else {
        assert.equal(messageText(answer).length, item.characters);
        assert.equal(messageText(answer, 'reasoning').length, item.thoughts);
      }
      if (item.mode !== 'disconnect') assert.deepEqual(live.sync.durable, stored);
      if (shadow) {
        await until(
          async () => {
            if (shadow!.recoverable()) shadow = await recoverBoundedSubscriber(shadow!, false);
            shadow!.check();
            if (shadow!.code() !== undefined)
              throw new Error(`Unexpected second-device close: ${shadow!.code()}`);
            return shadow!.sync.durable.seq === stored.seq;
          },
          'second device',
          90_000,
        );
        shadow.check();
        assert.deepEqual(shadow.sync.durable, stored);
        shadow.socket.close();
      }
      if (slow) {
        await until(() => slow.code() === 4002, 'bounded slow subscriber');
        slow.check();
        const recovered = await subscriber(id, slow.sync.durable);
        assert.deepEqual(recovered.sync.durable, stored);
        recovered.socket.close();
      }
      const replay = await subscriber(id);
      assert.deepEqual(replay.sync.durable, stored);
      replay.socket.close();
      live.socket.close();
      results.push({
        scenario: item.name,
        conversationId: id,
        status: answer.status,
        contentCharacters: messageText(answer).length,
        reasoningCharacters: messageText(answer, 'reasoning').length,
        elapsedMs: Date.now() - begin,
        generationElapsedMs,
        observationElapsedMs,
        reconnects,
        client: {
          frames: earlierClient.frames + live.received.frames,
          bytes: earlierClient.bytes + live.received.bytes,
        },
      });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} catch (error) {
  const value = error as { name?: string; code?: string; cause?: { code?: string } };
  failure = {
    phase,
    scenario: currentScenario,
    name: value.name ?? 'Error',
    code: value.code ?? value.cause?.code,
  };
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  agent.destroy();
  setGlobalDispatcher(previousDispatcher);
  await dispatcher.destroy();
  const output = resolve(values.output!);
  await writeReport(output, {
    version: 1,
    runtime: 'deployed Cloudflare isolated fixture',
    workerName: 'everchat-stream-validation',
    plan: 'Workers Free (user confirmed)',
    suite: values.suite,
    selectedScenarios,
    diagnosticCounters: false,
    expectedScenarios,
    complete: results.length === expectedScenarios,
    startedAt,
    finishedAt: new Date().toISOString(),
    failure,
    results,
    scope:
      'Functional cases with mock suppliers; platform analytics collected separately. No real model calls or production data.',
  });
}
