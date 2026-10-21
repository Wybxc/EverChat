import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { valibotSchema } from '@ai-sdk/valibot';
import { experimental_streamTextLowMemory as streamText, tool, wrapLanguageModel } from 'ai';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig, ProviderKind } from '../../../shared/providers/types';
import { webToolInputSchemas } from '../../../shared/web-tools/tasks';
import { providerCallOptions, providerModel } from '../../../worker/providers/sdk';
import { ProviderToolCollector } from '../../../worker/providers/tool-turn';
import { ProviderWireGuard } from '../../../worker/providers/stream-errors';
import { toolQuery, toolStream } from '../../support/providers/tool-streams';

const enabled = ['web_search', 'read_webpage'] as const;
const tools = {
  web_search: tool({ inputSchema: valibotSchema(webToolInputSchemas.web_search) }),
  read_webpage: tool({ inputSchema: valibotSchema(webToolInputSchemas.read_webpage) }),
};
for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as ProviderKind[])
  test(`Core single-consumer ${provider} preserves private continuation on the original stream without extra requests`, async () => {
    const config: ProviderConfig = {
      provider,
      baseUrl: 'https://fixture.example/v1',
      apiKey: 'fixture-key',
      model: 'fixture',
      systemPrompt: '',
      maxOutputTokens: null,
      reasoningEnabled: true,
      modelMetadata: resolveModelMetadata(provider, {
        id: 'fixture',
        name: 'Fixture',
        enabled: true,
        metadataOverrides: { toolCalls: true },
      }),
    };
    let requests = 0;
    const signal = new AbortController().signal,
      guard = new ProviderWireGuard();
    const collector = new ProviderToolCollector(config, enabled);
    const native: LanguageModelV4StreamPart[] = [];
    const model = wrapLanguageModel({
      model: providerModel(config, async () => {
        requests++;
        return new Response(
          guard.wrap(
            new Response(toolStream(provider, { redacted: true, signature: ['first-', 'second'] }))
              .body!,
            signal,
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
      middleware: {
        async wrapStream({ doStream }) {
          const result = await doStream();
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  collector.add(part);
                  native.push(part);
                  controller.enqueue(part);
                },
              }),
            ),
          };
        },
      },
    });
    const options = providerCallOptions(config, [], signal);
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Find sources' }],
      tools,
      maxRetries: 0,
      includeRawChunks: true,
      abortSignal: signal,
      providerOptions: options.providerOptions,
      reasoning: options.reasoning,
      onError() {},
    });
    const calls = [];
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'tool-call') {
        calls.push(part);
        collector.acceptCall(part);
      }
    }
    assert.equal(requests, 1);
    assert.equal(guard.ended, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { query: toolQuery });
    const turn = collector.finish({}, true);
    assert.equal(turn.calls[0].id, 'call_0');
    const serialized = JSON.stringify(turn);
    if (provider === 'anthropic') assert.match(serialized, /first-second/);
    if (provider === 'openai-responses') assert.match(serialized, /encrypted-fixture/);
    if (provider === 'gemini') assert.match(serialized, /fixture-signature/);
    assert.ok(native.some((part) => part.type === 'raw'));
    await guard.cancel();
  });
