import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { MAX_MESSAGE_TEXT_BYTES } from '../../../shared/conversation/limits';
import { messageParts, messagePartsSchema } from '../../../shared/conversation/content';
import type { ProviderKind } from '../../../shared/providers/types';
import {
  encodeGenerationEvent,
  MAX_EVENT_CHARACTERS,
  ProviderStream,
} from '../../../shared/streaming/provider-stream';
import { applicationStreams } from '../../support/providers/streams';
const encoder = new TextEncoder();

for (const [protocol, fixture] of Object.entries(applicationStreams)) {
  const kind = protocol as ProviderKind;
  test(`${kind} application checkpoint restores across every byte boundary, including UTF-8 and JSON`, () => {
    const bytes = encoder.encode(fixture.partial + fixture.finish);
    for (let split = 0; split <= bytes.length; split++) {
      let parser = new ProviderStream(kind, true);
      parser.feed(bytes.subarray(0, split));
      parser = new ProviderStream(
        kind,
        true,
        parser.checkpoint(),
        parser.content,
        parser.reasoning,
      );
      parser.feed(bytes.subarray(split));
      parser.assertComplete();
      assert.equal(parser.content, '**正文🙂**\n答案。');
      assert.equal(parser.reasoning, '**思考🙂**\n结论。');
      assert.equal(parser.checkpoint().usage.inputTokens, kind === 'anthropic' ? 14 : 10);
      assert.equal(parser.checkpoint().textDeltas, 2);
      assert.equal(parser.checkpoint().reasoningDeltas, 2);
    }
  });
  test(`${kind} one-byte restoration and absent terminal detection retain the confirmed prefix`, () => {
    let parser = new ProviderStream(kind, true);
    for (const byte of encoder.encode(fixture.partial)) {
      parser.feed(Uint8Array.of(byte));
      parser = new ProviderStream(
        kind,
        true,
        parser.checkpoint(),
        parser.content,
        parser.reasoning,
      );
    }
    assert.throws(() => parser.assertComplete(), /提前结束/);
    assert.equal(parser.content, '**正文🙂**\n');
    parser.feed(encoder.encode(fixture.finish));
    parser.assertComplete();
  });
}

test('application events replace a displayed summary, including after a restored checkpoint', () => {
  let parser = new ProviderStream('openai-responses', true);
  parser.feed(encodeGenerationEvent({ type: 'reasoning', text: '摘要' }));
  parser = new ProviderStream('openai-responses', true, parser.checkpoint(), '', parser.reasoning);
  parser.feed(encodeGenerationEvent({ type: 'reasoning', text: '**完整思考🙂**', replace: true }));
  assert.equal(parser.reasoning, '**完整思考🙂**');
  assert.deepEqual(parser.drainDeltas(), [
    { kind: 'reasoning', text: '**完整思考🙂**', replace: true },
  ]);
  assert.doesNotMatch(JSON.stringify(parser.checkpoint()), /摘要|完整思考|providerOptions/);
});

test('escaped-text budget preserves a split surrogate pair and a usable prefix', () => {
  let parser = new ProviderStream('openai-chat', true);
  parser.feed(encodeGenerationEvent({ type: 'reasoning', text: 'r'.repeat(200_000) }));
  parser.feed(
    encodeGenerationEvent({
      type: 'text',
      text: 'x'.repeat(MAX_MESSAGE_TEXT_BYTES - 200_000 - 6) + '\ud83d',
    }),
  );
  parser = new ProviderStream(
    'openai-chat',
    true,
    parser.checkpoint(),
    parser.content,
    parser.reasoning,
  );
  parser.feed(encodeGenerationEvent({ type: 'text', text: '\ude42zz' }));
  assert.ok(parser.content.endsWith('🙂zz'));
  assert.equal(parser.failed, false);
  parser.feed(encodeGenerationEvent({ type: 'text', text: 'overflow' }));
  assert.equal(parser.failed, true);
  assert.ok(
    v.safeParse(messagePartsSchema, messageParts(parser.content, parser.reasoning)).success,
  );
});

test('malformed events, native SSE, invalid UTF-8 and oversized partial frames never become completed responses', () => {
  for (const bytes of [
    encoder.encode('data: {}\n\n'),
    Uint8Array.of(0xff),
    encoder.encode('x'.repeat(MAX_EVENT_CHARACTERS + 1)),
    encoder.encode('{"type":"usage","usage":{"inputTokens":-1}}\n'),
  ]) {
    const parser = new ProviderStream('openai-chat', true);
    parser.feed(encodeGenerationEvent({ type: 'text', text: 'prefix' }));
    parser.feed(bytes);
    assert.throws(() => parser.assertComplete());
    assert.equal(parser.content, 'prefix');
  }
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(encodeGenerationEvent({ type: 'text', text: 'prefix' }));
  parser.feed(Uint8Array.of(0xf0, 0x9f));
  assert.throws(() => parser.assertComplete());
});

test('finish classifications preserve raw reasons and provider messages while partial counts remain non-final', () => {
  const parser = new ProviderStream('gemini', true);
  parser.feed(encodeGenerationEvent({ type: 'text', text: 'prefix' }));
  parser.feed(encodeGenerationEvent({ type: 'usage', usage: { inputTokens: 4 } }));
  assert.equal(parser.checkpoint().usageIsFinal, false);
  parser.feed(
    encodeGenerationEvent({
      type: 'finish',
      reason: 'content-filter',
      rawReason: 'SAFETY',
      message: 'Blocked',
      usage: { outputTokens: 2 },
      usageIsFinal: false,
    }),
  );
  assert.throws(() => parser.assertComplete(), /Blocked/);
  assert.equal(parser.checkpoint().rawFinishReason, 'SAFETY');
  assert.deepEqual(parser.checkpoint().usage, { inputTokens: 4, outputTokens: 2 });
});
