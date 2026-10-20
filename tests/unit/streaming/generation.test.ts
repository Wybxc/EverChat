import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import type { ProviderKind } from '../../../shared/providers/types';
import { generationSchema } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { FirstTokenProbe, generationTiming } from '../../../worker/generation/timing';
import { applicationStreams as providerStreams } from '../../support/providers/streams';

const encoder = new TextEncoder();
const frame = (event: unknown) => encoder.encode(JSON.stringify(event) + '\n');

for (const [kind, fixture] of Object.entries(providerStreams)) {
  test(`${kind} observes the first output once across fragmented UTF-8, then stops parsing`, () => {
    const observed: number[] = [],
      probe = new FirstTokenProbe(kind as ProviderKind, (at) => observed.push(at));
    probe.feed(frame({ type: 'usage', usage: {} }), 0);
    probe.feed(frame({ type: 'text', text: '' }), 10);
    assert.deepEqual(observed, []);
    const bytes = encoder.encode(fixture.partial);
    for (let index = 0; index < bytes.length; index++)
      probe.feed(bytes.subarray(index, index + 1), 20 + index);
    assert.equal(observed.length, 1);
    assert.ok(observed[0] > 20);
    probe.feed(Uint8Array.of(0xff), 5000);
    probe.feed(encoder.encode(fixture.finish), 6000);
    probe.end(7000);
    assert.equal(observed.length, 1);
  });
}

test('first output includes thoughts and ignores empty events', () => {
  const observed: number[] = [],
    probe = new FirstTokenProbe('openai-chat', (at) => observed.push(at));
  probe.feed(frame({ type: 'reasoning', text: '' }), 10);
  probe.feed(frame({ type: 'reasoning', text: '思考' }), 200);
  probe.end(210);
  assert.deepEqual(observed, [200]);
});

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
