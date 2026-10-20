import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { generationSchema } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { generationTiming } from '../../../worker/generation/timing';

const encoder = new TextEncoder();
const frame = (event: unknown) => encoder.encode(JSON.stringify(event) + '\n');

test('cloud timing separates queueing, first output and supplier duration and leaves unobserved values absent', () => {
  assert.deepEqual(
    generationTiming(1000, 3000, { providerStartedAt: 3100, firstTokenAt: 3600 }, 9000),
    { queueMs: 2000, firstTokenMs: 500, durationMs: 5900 },
  );
  assert.deepEqual(generationTiming(1000, null), {});
  assert.deepEqual(generationTiming(1000, 1000, { providerStartedAt: 1001, firstTokenAt: null }), {
    queueMs: 0,
  });
  assert.deepEqual(
    generationTiming(1000, 1000, { providerStartedAt: 1001, firstTokenAt: 1001 }, 1001),
    { queueMs: 0, firstTokenMs: 0, durationMs: 0 },
  );
});

test('generation metadata validation rejects invalid counters and leaked fields while preserving zero and unknown', () => {
  const base = { usage: { inputTokens: 0 }, usageIsFinal: false, timing: { firstTokenMs: 0 } };
  assert.deepEqual(v.parse(generationSchema, base), base);
  assert.deepEqual(v.parse(generationSchema, { ...base, interrupted: true }), {
    ...base,
    interrupted: true,
  });
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '12']) {
    assert.equal(
      v.safeParse(generationSchema, { ...base, usage: { inputTokens: value } }).success,
      false,
    );
    assert.equal(
      v.safeParse(generationSchema, { ...base, timing: { durationMs: value } }).success,
      false,
    );
  }
  for (const value of [
    { ...base, apiKey: 'secret' },
    { ...base, usage: { apiKey: 'secret' } },
    { ...base, timing: { apiKey: 'secret' } },
    { ...base, usageIsFinal: 'true' },
    { ...base, interrupted: 'true' },
  ])
    assert.equal(v.safeParse(generationSchema, value).success, false);
});

test('a completed application stream preserves a non-final supplier usage report', () => {
  const parser = new ProviderStream('anthropic', false);
  parser.feed(frame({ type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } }));
  parser.feed(frame({ type: 'text', text: '回答' }));
  parser.feed(frame({ type: 'finish', reason: 'stop', usage: {}, usageIsFinal: false }));
  parser.assertComplete();
  assert.equal(parser.checkpoint().usageIsFinal, false);
  assert.equal(parser.checkpoint().usage.outputTokens, 0);
});
