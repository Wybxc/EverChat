import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { generationSchema } from '../shared/streaming/generation';
import { ProviderStream } from '../shared/streaming/provider-stream';
import { FirstTokenProbe, generationTiming } from '../worker/generation-timing';
import { providerStreams } from './fixtures/provider-streams';
import type { ProviderKind } from '../shared/providers/types';

const encoder = new TextEncoder();
const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`);

for (const [kind, fixture] of Object.entries(providerStreams)) {
  test(`${kind} observes the first output once across fragmented UTF-8, then stops parsing`, () => {
    const observed: number[] = [], probe = new FirstTokenProbe(kind as ProviderKind, (at) => observed.push(at));
    probe.feed(encoder.encode(': keepalive\r\n\r\n'), 0);
    probe.feed(frame({ choices: [{ delta: { role: 'assistant', content: '' } }], type: 'response.created' }), 10);
    assert.deepEqual(observed, []);
    const bytes = encoder.encode(fixture.partial);
    for (let index = 0; index < bytes.length; index++) probe.feed(bytes.subarray(index, index + 1), 20 + index);
    assert.equal(observed.length, 1); assert.ok(observed[0] > 20);
    probe.feed(Uint8Array.of(0xff), 5000); probe.feed(encoder.encode(fixture.finish), 6000); probe.end(7000);
    assert.equal(observed.length, 1);
  });
}

test('first output includes hidden thoughts, ignores empty events, and resolves a trailing CR at EOF', () => {
  const observed: number[] = [], probe = new FirstTokenProbe('openai-chat', (at) => observed.push(at));
  probe.feed(frame({ choices: [{ delta: { content: null, reasoning_content: '' } }] }), 10);
  probe.feed(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\r\r'), 200);
  assert.deepEqual(observed, []); probe.end(210); assert.deepEqual(observed, [210]);
  const malformed: number[] = [], invalid = new FirstTokenProbe('openai-chat', (at) => malformed.push(at));
  invalid.feed(Uint8Array.of(0xff), 100); invalid.feed(frame({ choices: [{ delta: { content: '无效流之后' } }] }), 200);
  assert.deepEqual(malformed, []);
});

test('cloud timing separates queueing, first output and supplier duration and leaves unobserved values absent', () => {
  assert.deepEqual(generationTiming(1000, 3000, { providerStartedAt: 3100, firstTokenAt: 3600 }, 9000), { queueMs: 2000, firstTokenMs: 500, durationMs: 5900 });
  assert.deepEqual(generationTiming(1000, null), {});
  assert.deepEqual(generationTiming(1000, 1000, { providerStartedAt: 1001, firstTokenAt: null }), { queueMs: 0 });
  assert.deepEqual(generationTiming(1000, 1000, { providerStartedAt: 1001, firstTokenAt: 1001 }, 1001), { queueMs: 0, firstTokenMs: 0, durationMs: 0 });
});

test('Anthropic adds disjoint input cache counts, preserves partial reports and does not accumulate cumulative output', () => {
  let parser = new ProviderStream('anthropic', false);
  parser.feed(frame({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } }));
  parser = new ProviderStream('anthropic', false, parser.checkpoint());
  parser.feed(frame({ type: 'message_delta', usage: { output_tokens: 4 } }));
  parser.feed(frame({ type: 'message_delta', usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 7 } } }));
  assert.deepEqual(parser.checkpoint().usage, { inputTokens: 123, uncachedInputTokens: 3, cachedInputTokens: 100, cacheWriteInputTokens: 20, outputTokens: 9, reasoningTokens: 7 });
  assert.equal(parser.checkpoint().usage.totalTokens, undefined);
});

test('Gemini counts thought and tool tokens once across independently arriving cumulative usage updates', () => {
  let parser = new ProviderStream('gemini', true);
  parser.feed(frame({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 0 } }));
  parser = new ProviderStream('gemini', true, parser.checkpoint());
  for (let repeat = 0; repeat < 2; repeat++) parser.feed(frame({ usageMetadata: { toolUsePromptTokenCount: 2, thoughtsTokenCount: 4 } }));
  parser.feed(frame({ usageMetadata: { candidatesTokenCount: 5, totalTokenCount: 21 } }));
  assert.deepEqual(parser.checkpoint().usage, { inputTokens: 12, outputTokens: 9, textOutputTokens: 5, cachedInputTokens: 0, toolInputTokens: 2, reasoningTokens: 4, totalTokens: 21 });
});

test('Chat usage accepts DeepSeek cache counters, empty choices and zeroes without fabricating missing usage', () => {
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(frame({ choices: [], usage: null })); assert.deepEqual(parser.checkpoint().usage, {});
  parser.feed(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, prompt_cache_hit_tokens: 8, total_tokens: 10 } }));
  assert.deepEqual(parser.checkpoint().usage, { inputTokens: 10, outputTokens: 0, cachedInputTokens: 8, totalTokens: 10 });
  parser.feed(frame({ usage: { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: '100', prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 } } }));
  assert.deepEqual(parser.checkpoint().usage, { inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 2, totalTokens: 10 });
});

test('generation metadata validation rejects invalid counters and leaked fields while preserving zero and unknown', () => {
  const base = { usage: { inputTokens: 0 }, usageIsFinal: false, timing: { firstTokenMs: 0 } };
  assert.deepEqual(v.parse(generationSchema, base), base);
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '12']) {
    assert.equal(v.safeParse(generationSchema, { ...base, usage: { inputTokens: value } }).success, false);
    assert.equal(v.safeParse(generationSchema, { ...base, timing: { durationMs: value } }).success, false);
  }
  for (const value of [{ ...base, apiKey: 'secret' }, { ...base, usage: { apiKey: 'secret' } }, { ...base, timing: { apiKey: 'secret' } }, { ...base, usageIsFinal: 'true' }]) assert.equal(v.safeParse(generationSchema, value).success, false);
});

test('a completed stream does not turn initial counters into a final usage report', () => {
  const anthropic = new ProviderStream('anthropic', false);
  anthropic.feed(frame({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }));
  anthropic.feed(frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '回答' } }));
  anthropic.feed(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
  anthropic.feed(frame({ type: 'message_stop' })); anthropic.assertComplete();
  assert.equal(anthropic.checkpoint().usageIsFinal, false);
  assert.equal(anthropic.checkpoint().usage.outputTokens, 0);
  const chat = new ProviderStream('openai-chat', false);
  chat.feed(frame({ choices: [{ delta: { role: 'assistant' } }], usage: { prompt_tokens: 10, completion_tokens: 0 } }));
  chat.feed(frame({ choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }] }));
  chat.feed(encoder.encode('data: [DONE]\n\n')); chat.assertComplete();
  assert.equal(chat.checkpoint().usageIsFinal, false);
});
