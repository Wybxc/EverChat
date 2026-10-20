import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderUsage } from '../../../worker/providers/stream-usage';
const event = (value: unknown) => value;
test('Anthropic adds disjoint input cache counts, preserves partial reports and does not accumulate cumulative output', () => {
  const usage = new ProviderUsage(),
    parser = {
      observe: (value: unknown) => usage.observe(value as Record<string, unknown>, 'anthropic'),
      get usage() {
        return usage.usage;
      },
    };
  parser.observe(
    event({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 3,
          output_tokens: 0,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    }),
  );
  parser.observe(event({ type: 'message_delta', usage: { output_tokens: 4 } }));
  parser.observe(
    event({
      type: 'message_delta',
      usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 7 } },
    }),
  );
  assert.deepEqual(parser.usage, {
    inputTokens: 123,
    uncachedInputTokens: 3,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 20,
    outputTokens: 9,
    reasoningTokens: 7,
  });
  assert.equal('totalTokens' in parser.usage, false);
});

test('Gemini counts thought and tool tokens once across independently arriving cumulative usage updates', () => {
  const usage = new ProviderUsage(),
    parser = {
      observe: (value: unknown) => usage.observe(value as Record<string, unknown>, 'gemini'),
      get usage() {
        return usage.usage;
      },
    };
  parser.observe(
    event({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 0 },
    }),
  );
  for (let repeat = 0; repeat < 2; repeat++)
    parser.observe(event({ usageMetadata: { toolUsePromptTokenCount: 2, thoughtsTokenCount: 4 } }));
  parser.observe(event({ usageMetadata: { candidatesTokenCount: 5, totalTokenCount: 21 } }));
  assert.deepEqual(parser.usage, {
    inputTokens: 12,
    outputTokens: 9,
    textOutputTokens: 5,
    cachedInputTokens: 0,
    toolInputTokens: 2,
    reasoningTokens: 4,
    totalTokens: 21,
  });
});

test('Chat usage accepts DeepSeek cache counters, empty choices and zeroes without fabricating missing usage', () => {
  const usage = new ProviderUsage(),
    parser = {
      observe: (value: unknown) => usage.observe(value as Record<string, unknown>, 'openai-chat'),
      get usage() {
        return usage.usage;
      },
    };
  parser.observe(event({ choices: [], usage: null }));
  assert.deepEqual(parser.usage, {});
  parser.observe(
    event({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        prompt_cache_hit_tokens: 8,
        total_tokens: 10,
      },
    }),
  );
  assert.deepEqual(parser.usage, {
    inputTokens: 10,
    outputTokens: 0,
    cachedInputTokens: 8,
    totalTokens: 10,
  });
  parser.observe(
    event({
      usage: {
        prompt_tokens: -1,
        completion_tokens: 1.5,
        total_tokens: '100',
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 },
      },
    }),
  );
  assert.deepEqual(parser.usage, {
    inputTokens: 10,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 2,
    totalTokens: 10,
  });
});
