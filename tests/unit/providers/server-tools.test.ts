import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ProviderConfig } from '../../../shared/providers/types';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import {
  resolveServerTools,
  serverToolCatalog,
  type ServerToolSelection,
} from '../../../shared/tools/server-tools';
import { openProviderStream } from '../../../worker/providers/stream';
import type { ProviderToolRequest } from '../../../worker/providers/tool-turn';
import { providerStreams } from '../../support/providers/streams';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import { includeServerToolCost } from '../../../shared/usage/server-tools';

const providerId = 'd23a51be-0e3d-41c6-aa15-e775c0555241';
const fixture = (
  overrides: Partial<ProviderConfig>,
  tools: ServerToolSelection[],
): ProviderConfig => {
  const config: ProviderConfig = {
    provider: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    apiKey: 'secret-test-key',
    providerId,
    maxOutputTokens: 512,
    systemPrompt: '',
    ...overrides,
  };
  return {
    ...config,
    serverTools: resolveServerTools(config, [{ providerId, model: config.model, tools }]),
  };
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stream = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const context = [{ role: 'user' as const, content: 'Find the official report.' }];

async function run(config: ProviderConfig, request?: ProviderToolRequest) {
  const body = await openProviderStream(
    config,
    context,
    new AbortController().signal,
    undefined,
    undefined,
    request,
  );
  const parser = new ProviderStream(config.provider, true);
  for await (const bytes of body) parser.feed(bytes);
  return { parser, turn: body.toolTurn };
}

test('provider tools are bound to the configured endpoint and model', () => {
  const config = fixture({}, [{ tool: 'web-search' }]);
  assert.equal(config.serverTools?.[0]?.wireName, 'web_search');
  assert.deepEqual(serverToolCatalog({ ...config, provider: 'openai-chat' }), []);
  assert.deepEqual(
    serverToolCatalog({ ...config, baseUrl: 'https://api.openai.com.example.org/v1' }),
    [],
  );
  assert.deepEqual(serverToolCatalog({ ...config, model: 'unknown' }), []);
  assert.throws(() =>
    fixture({}, [{ tool: 'file-search', resources: ['fileSearchStores/mismatch'] }]),
  );
});

test('OpenAI Responses executes web search in the provider and keeps only safe public citations', async (t) => {
  const config = fixture({}, [{ tool: 'web-search' }]);
  const item = { type: 'web_search_call', id: 'native_1', status: 'in_progress' };
  const native =
    frame({ type: 'response.output_item.added', output_index: 8, item }) +
    frame({
      type: 'response.output_item.done',
      output_index: 8,
      item: {
        ...item,
        status: 'completed',
        action: {
          type: 'search',
          query: 'private',
          sources: [
            { type: 'url', url: 'https://example.org/report' },
            { type: 'url', url: 'https://example.org/secret-test-key' },
          ],
        },
      },
    }) +
    frame({
      type: 'response.output_text.annotation.added',
      item_id: 'answer',
      output_index: 1,
      content_index: 0,
      annotation_index: 0,
      annotation: {
        type: 'url_citation',
        url: 'https://example.org/report',
        title: 'Report',
        start_index: 0,
        end_index: 1,
      },
    });
  const response = providerStreams['openai-responses'];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    calls++;
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.store, false);
    assert.equal(payload.max_tool_calls, 4);
    assert.equal(payload.tools[0]?.type, 'web_search');
    return stream(response.partial + native + response.finish);
  });
  const { parser } = await run(config);
  parser.assertComplete();
  assert.equal(calls, 1);
  const [entry] = parser.checkpoint().serverTools ?? [];
  assert.equal(entry?.status, 'completed');
  assert.equal(entry?.vendor, 'openai');
  assert.deepEqual(entry?.sources, [{ title: 'Report', url: 'https://example.org/report' }]);
  assert.doesNotMatch(JSON.stringify(parser.checkpoint()), /private|secret-test-key|native_1/);
  const usage = parser.checkpoint().serverToolUsage;
  assert.deepEqual(usage, [
    { tool: 'web-search', unit: 'call', count: 1, source: 'observed', usdPerUnit: '0.01' },
  ]);
  assert.deepEqual(
    includeServerToolCost({ currency: 'USD', amount: '5000000000', state: 'priced' }, usage),
    { currency: 'USD', amount: '15000000000', state: 'priced' },
  );
});

const anthropicStart = frame({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
const anthropicFinish = (reason: string) =>
  frame({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } }) +
  frame({ type: 'message_stop' });
const block = (index: number, content_block: unknown) =>
  frame({ type: 'content_block_start', index, content_block }) +
  frame({ type: 'content_block_stop', index });
const hostedCall = {
  type: 'server_tool_use',
  id: 'srvtoolu_fixture',
  name: 'web_search',
  input: { query: 'report' },
};
const hostedResult = {
  type: 'web_search_tool_result',
  tool_use_id: hostedCall.id,
  content: [
    {
      type: 'web_search_result',
      title: 'Report',
      url: 'https://example.org/report',
      encrypted_content: 'private-result-signature',
    },
  ],
};
function anthropicFixture(t: TestContext, fixtures: string[]) {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    const wire = fixtures[requests.length];
    assert.ok(wire, 'duplicate supplier request');
    requests.push(JSON.parse(String(init.body)));
    return stream(wire);
  });
  return requests;
}

test('Anthropic pause resumes with unchanged private assistant blocks and the same tools', async (t) => {
  const config = fixture(
    { baseUrl: 'https://api.anthropic.com/v1', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    [{ tool: 'web-search' }],
  );
  const response = providerStreams.anthropic;
  const requests = anthropicFixture(t, [
    anthropicStart + block(0, hostedCall) + anthropicFinish('pause_turn'),
    response.partial + block(2, hostedResult) + response.finish,
  ]);
  const paused = await run(config, { enabled: [] });
  paused.parser.assertEnded();
  assert.equal(paused.turn?.finishReason, 'pause');
  assert.deepEqual(paused.turn?.calls, []);
  assert.equal(paused.parser.checkpoint().serverTools?.[0]?.status, 'running');
  const resumed = await run(config, {
    enabled: [],
    exchanges: [{ turn: paused.turn!, outcomes: [] }],
  });
  resumed.parser.assertComplete();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.deepEqual((requests[1].messages as unknown[]).at(-1), {
    role: 'assistant',
    content: [hostedCall],
  });
  assert.equal(resumed.parser.checkpoint().serverTools?.[0]?.status, 'completed');
  assert.equal(
    resumed.parser.checkpoint().serverTools?.[0]?.id,
    paused.parser.checkpoint().serverTools?.[0]?.id,
  );
  assert.doesNotMatch(JSON.stringify(resumed.parser.checkpoint()), /private-result-signature/);
});

test('Claude search and an EverChat attachment function preserve interleaved blocks on continuation', async (t) => {
  const config = fixture(
    {
      baseUrl: 'https://api.anthropic.com/v1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelMetadata: resolveModelMetadata('anthropic', {
        id: 'claude-sonnet-4-6',
        name: 'Claude',
        enabled: true,
        metadataOverrides: { toolCalls: true },
      }),
    },
    [{ tool: 'web-search' }],
  );
  const attachmentCall = {
    type: 'tool_use',
    id: 'toolu_attachment',
    name: 'attachment_info',
    input: { files: [{ attachmentId: providerId, textSha256: '1'.repeat(64) }] },
  };
  const answer = providerStreams.anthropic;
  const requests = anthropicFixture(t, [
    anthropicStart +
      block(0, hostedCall) +
      block(1, hostedResult) +
      block(2, attachmentCall) +
      anthropicFinish('tool_use'),
    answer.partial + answer.finish,
  ]);
  const enabled = ['attachment_info'] as const;
  const first = await run(config, { enabled });
  assert.deepEqual(first.turn?.calls, [
    { id: attachmentCall.id, name: attachmentCall.name, input: attachmentCall.input },
  ]);
  assert.equal(first.parser.checkpoint().serverTools?.[0]?.tool, 'web-search');
  const next = await run(config, {
    enabled,
    exchanges: [
      {
        turn: first.turn!,
        outcomes: [
          { id: attachmentCall.id, name: 'attachment_info', status: 'completed', sources: [] },
        ],
      },
    ],
  });
  next.parser.assertComplete();
  const messages = requests[1].messages as { role: string; content: unknown[] }[];
  assert.deepEqual(messages.at(-2)?.content, [hostedCall, hostedResult, attachmentCall]);
  assert.deepEqual(messages.at(-1)?.content, [
    {
      type: 'tool_result',
      tool_use_id: attachmentCall.id,
      content: JSON.stringify({ sources: [] }),
    },
  ]);
});

test('DeepSeek Chat tool progress and authoritative counts are deduplicated', async (t) => {
  const config = fixture(
    {
      baseUrl: 'https://api.deepseek.com/v1',
      provider: 'openai-chat',
      model: 'deepseek-flash',
    },
    [{ tool: 'web-search' }],
  );
  const call = {
    id: 'ds-search',
    type: 'deepseek_web_search',
    status: 'completed',
    sources: [{ url: 'https://example.org/news', title: 'News' }],
    signature: 'private-ds',
  };
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).tools, [{ type: 'deepseek_web_search' }]);
    return stream(
      frame({
        choices: [{ index: 0, delta: {}, server_tool_event: { type: 'call_completed', call } }],
      }) +
        frame({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              delta: { content: 'Result', server_tool_calls: [{ calls: [call] }] },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
            server_tool_use: { tool_search: 2 },
          },
        }) +
        'data: [DONE]\n\n',
    );
  });
  const { parser } = await run(config);
  parser.assertComplete();
  assert.equal(parser.checkpoint().serverTools?.length, 1);
  assert.deepEqual(parser.checkpoint().serverToolUsage, [
    { tool: 'web-search', unit: 'call', count: 2, source: 'reported', usdPerUnit: '0' },
  ]);
  assert.doesNotMatch(JSON.stringify(parser.checkpoint()), /private-ds/);
});

test('Gemini GenerateContent exposes grounding sources and URL retrieval status', async (t) => {
  const config = fixture(
    {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      provider: 'gemini',
      model: 'gemini-4-argon',
    },
    [{ tool: 'web-search' }, { tool: 'web-fetch' }],
  );
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).tools, [
      { googleSearch: {} },
      { urlContext: {} },
    ]);
    return stream(
      frame({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'Result' }] },
            finishReason: 'STOP',
            groundingMetadata: {
              webSearchQueries: ['q', 'q'],
              groundingChunks: [{ web: { title: 'Report', uri: 'https://example.org/report' } }],
            },
            urlContextMetadata: {
              urlMetadata: [
                {
                  retrievedUrl: 'https://example.org/private',
                  urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR',
                },
              ],
            },
          },
        ],
      }),
    );
  });
  const { parser } = await run(config);
  parser.assertComplete();
  assert.deepEqual(
    parser.checkpoint().serverTools?.map(({ tool, status }) => [tool, status]),
    [
      ['web-search', 'completed'],
      ['web-fetch', 'failed'],
    ],
  );
  assert.equal(parser.checkpoint().serverToolUsage?.[0]?.count, 1);
});
