import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
  APICallError,
  JSONParseError,
  TypeValidationError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import { sdkDiagnostics, sdkProviderError } from '../../../worker/providers/sdk-diagnostics';
import { mergeGenerationDiagnostics } from '../../../shared/streaming/diagnostics';
import { generationSchema } from '../../../shared/streaming/generation';
import { ProviderStream, encodeGenerationEvent } from '../../../shared/streaming/provider-stream';
import { webToolDefinitions } from '../../../worker/providers/tool-turn';
import { validateWebToolCall } from '../../../shared/web-tools/tasks';
import { ProviderUsage } from '../../../worker/providers/stream-usage';
import type { ProviderConfig } from '../../../shared/providers/types';
import { AppError, problem } from '../../../shared/errors/descriptor';

const config: ProviderConfig = {
  provider: 'openai-chat',
  model: 'fixture',
  apiKey: 'private-key',
  baseUrl: 'https://fixture.invalid',
  systemPrompt: 'private prompt',
  maxOutputTokens: null,
};

test('public SDK diagnostics are bounded, sanitized, and strict across partial checkpoints and backup validation', () => {
  const warning = sdkDiagnostics(
    {
      type: 'stream-start',
      warnings: Array.from({ length: 20 }, () => ({
        type: 'unsupported',
        feature: 'temperature',
        details: 'private-key private prompt ' + 'x'.repeat(2000),
      })),
    },
    config,
    [],
  );
  assert.equal(warning.warnings.length, 8);
  assert.ok(warning.warnings[0].length <= 512);
  assert.doesNotMatch(warning.warnings.join(), /private-key|private prompt/);
  const metadata = sdkDiagnostics(
    {
      type: 'response-metadata',
      id: 'response-1',
      modelId: 'actual-model',
      timestamp: new Date(1000),
    },
    config,
    [],
  );
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(encodeGenerationEvent({ type: 'usage', usage: {}, diagnostics: warning }));
  const resumed = new ProviderStream(
    'openai-chat',
    true,
    JSON.parse(JSON.stringify(parser.checkpoint())),
  );
  resumed.feed(encodeGenerationEvent({ type: 'usage', usage: {}, diagnostics: metadata }));
  const diagnostics = resumed.checkpoint().diagnostics;
  assert.equal(diagnostics?.response?.model, 'actual-model');
  assert.equal(diagnostics?.warnings.length, 1);
  const generation = { usage: {}, usageIsFinal: false, diagnostics };
  assert.deepEqual(v.parse(generationSchema, generation), generation);
  assert.equal(
    v.safeParse(generationSchema, {
      ...generation,
      diagnostics: { ...diagnostics, providerMetadata: { signature: 'private' } },
    }).success,
    false,
  );
  assert.equal(
    v.safeParse(generationSchema, {
      ...generation,
      diagnostics: { warnings: [], response: { apiKey: 'private' } },
    }).success,
    false,
  );
  assert.equal(
    mergeGenerationDiagnostics(diagnostics, {
      warnings: ['second round'],
      response: { id: 'response-2' },
    })?.response?.id,
    'response-2',
  );
});

test('typed SDK HTTP and validation errors preserve safe diagnostics without request values or retries', () => {
  const invalidTool = sdkProviderError(
    new AppError(problem('TOOL_INVALID'), '工具参数无效。'),
    config,
    'protocol',
  );
  assert.equal(invalidTool.details?.stage, 'tool');
  assert.equal(invalidTool.issue.code, 'TOOL_INVALID');
  const error = new APICallError({
    message: 'raw private prompt',
    url: config.baseUrl,
    requestBodyValues: { messages: ['private prompt'] },
    statusCode: 429,
    responseHeaders: { 'x-request-id': 'request-1' },
    responseBody: JSON.stringify({
      error: { code: 'rate_limit', message: 'rate limit private-key', detail: 'retry later' },
      request: { messages: ['private prompt'] },
    }),
  });
  const failure = sdkProviderError(error, config, 'connect').details!;
  assert.equal(failure.stage, 'response');
  assert.equal(failure.status, 429);
  assert.equal(failure.code, 'rate_limit');
  assert.equal(failure.requestId, 'request-1');
  assert.match(failure.responseBody!, /retry later/);
  assert.doesNotMatch(JSON.stringify(failure), /private-key|private prompt/);
  const malformed = new APICallError({
    message: 'Failed successful response',
    url: config.baseUrl,
    requestBodyValues: {},
    statusCode: 200,
    responseBody: '{invalid',
    cause: new JSONParseError({ text: '{invalid', cause: new Error('parse') }),
  });
  const protocol = sdkProviderError(malformed, config, 'connect');
  assert.equal(protocol.details?.stage, 'protocol');
  assert.equal(protocol.details?.responseBody, '{invalid');
  assert.match(protocol.message, /格式|完整/);
  for (const invalid of [
    new EmptyResponseBodyError(),
    new InvalidResponseDataError({ data: { prompt: 'private prompt' } }),
    new NoSuchModelError({ modelId: 'fixture', modelType: 'languageModel' }),
    new UnsupportedFunctionalityError({ functionality: 'image input' }),
    new JSONParseError({ text: 'private prompt', cause: new Error('private-key') }),
    new TypeValidationError({
      value: { prompt: 'private prompt' },
      cause: new Error('private-key'),
    }),
  ]) {
    const parsed = sdkProviderError(invalid, config, 'connect').details!;
    assert.equal(parsed.stage, 'protocol');
    assert.doesNotMatch(JSON.stringify(parsed), /private-key|private prompt/);
  }
});

test('tool JSON schemas and validation share query constraints while URL and service policies stay explicit', () => {
  const definitions = webToolDefinitions(['web_search', 'read_webpage']);
  const query = (definitions[0].inputSchema as { properties: { query: { maxLength: number } } })
    .properties.query;
  assert.equal(query.maxLength, 500);
  assert.equal(
    validateWebToolCall({ id: 'call-1', name: 'web_search', input: { query: 'q'.repeat(500) } }, [
      'web_search',
    ]).name,
    'web_search',
  );
  for (const text of ['q'.repeat(501), '   ', 'bad\u0000'])
    assert.throws(() =>
      validateWebToolCall({ id: 'call-1', name: 'web_search', input: { query: text } }, [
        'web_search',
      ]),
    );
  assert.throws(() =>
    validateWebToolCall(
      { id: 'call-1', name: 'read_webpage', input: { url: 'https://localhost/private' } },
      ['read_webpage'],
    ),
  );
});

test('SDK usage enriches known cache/reasoning dimensions without fabricating defaults or overwriting supplier totals', () => {
  const sdk = {
    inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: undefined },
    outputTokens: { total: 5, text: 3, reasoning: 2 },
  };
  const usage = new ProviderUsage();
  usage.mergeSdk(sdk);
  assert.deepEqual(usage.usage, {});
  usage.record(
    {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
    'openai-chat',
  );
  usage.mergeSdk(sdk);
  assert.deepEqual(usage.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 4,
    reasoningTokens: 2,
    uncachedInputTokens: 6,
    textOutputTokens: 3,
  });
  const missing = new ProviderUsage();
  missing.record({ prompt_tokens: 10, completion_tokens: 5 }, 'openai-chat');
  missing.mergeSdk({
    ...sdk,
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  });
  assert.deepEqual(missing.usage, { inputTokens: 10, outputTokens: 5 });
  const deepseek = new ProviderUsage();
  deepseek.record({ prompt_tokens: 10, prompt_cache_hit_tokens: 8 }, 'openai-chat');
  deepseek.mergeSdk(sdk);
  assert.equal(deepseek.usage.uncachedInputTokens, 2);
});

test('public HTTPS policy preserves case-insensitive schemes', () => {
  assert.equal(
    validateWebToolCall(
      { id: 'call-1', name: 'read_webpage', input: { url: 'HTTPS://example.com/' } },
      ['read_webpage'],
    ).name,
    'read_webpage',
  );
});
