import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVENT_CHARACTERS, ProviderStream } from '../shared/provider-stream';
import { providerStreams } from './fixtures/provider-streams';
import type { ProviderKind } from '../shared/types';
const encoder = new TextEncoder();

test('Responses bounds thought identities while retaining an already decoded prefix', () => {
  const parser = new ProviderStream('openai-responses', true);
  for (const event of [
    { type: 'response.reasoning_text.delta', item_id: 'thought', delta: '已保存思考' },
    { type: 'response.reasoning_text.delta', item_id: 'x'.repeat(201), delta: '超限片段' },
  ]) parser.feed(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  assert.equal(parser.reasoning, '已保存思考');
  assert.match(parser.checkpoint().failure ?? '', /标识超过/);
  assert.deepEqual(parser.checkpoint().thoughts, [{ id: 'thought:0', raw: '已保存思考', summary: '' }]);
});

for (const [protocol, fixture] of Object.entries(providerStreams)) {
  const kind = protocol as ProviderKind;
  test(`${kind} restores across every raw byte boundary, including partial UTF-8, CRLF and JSON`, () => {
    const bytes = encoder.encode('\ufeff: keepalive\r\n\r\n' + fixture.partial + fixture.finish);
    for (let split = 0; split <= bytes.length; split++) {
      let parser = new ProviderStream(kind, true);
      parser.feed(bytes.subarray(0, split));
      const checkpoint = parser.checkpoint();
      assert.ok(checkpoint.tail.length <= MAX_EVENT_CHARACTERS);
      parser = new ProviderStream(kind, true, checkpoint, parser.content, parser.reasoning);
      parser.feed(bytes.subarray(split)); parser.assertComplete();
      assert.equal(parser.content, '**正文🙂**\n答案。'); assert.equal(parser.reasoning, '**思考🙂**\n结论。');
      assert.equal(parser.checkpoint().usage.inputTokens, kind === 'anthropic' ? 14 : 10);
      assert.equal(parser.checkpoint().usage.outputTokens, kind === 'gemini' ? 7 : 5);
      assert.equal(parser.checkpoint().usage.cachedInputTokens, 4);
      assert.equal(parser.checkpoint().textDeltas, 2); assert.equal(parser.checkpoint().reasoningDeltas, 2);
    }
  });
  test(`${kind} resumes one byte at a time and its confirmed prefix never includes a partial frame`, () => {
    const bytes = encoder.encode(fixture.partial + fixture.finish);
    let parser = new ProviderStream(kind, true);
    for (const byte of bytes) {
      parser.feed(Uint8Array.of(byte));
      parser = new ProviderStream(kind, true, parser.checkpoint(), parser.content, parser.reasoning);
    }
    parser.assertComplete(); assert.equal(parser.content, '**正文🙂**\n答案。'); assert.equal(parser.reasoning, '**思考🙂**\n结论。');
  });
  test(`${kind} rejects missing completion markers and supplier errors while retaining the text prefix`, () => {
    const parser = new ProviderStream(kind, true);
    parser.feed(encoder.encode(fixture.partial));
    assert.equal(parser.content, '**正文🙂**\n'); assert.throws(() => parser.assertComplete(), /提前结束/);
    parser.feed(encoder.encode('data: {"error":{"message":"private-key diagnostic"}}\n\n'));
    assert.throws(() => parser.assertComplete(), (error: Error) => /返回错误/.test(error.message) && !error.message.includes('private-key'));
    assert.equal(parser.content, '**正文🙂**\n');
  });
  test(`${kind} can hide thoughts without changing the visible answer or protocol completion`, () => {
    const parser = new ProviderStream(kind, false); parser.feed(encoder.encode(fixture.partial + fixture.finish)); parser.assertComplete();
    assert.equal(parser.reasoning, ''); assert.equal(parser.checkpoint().reasoningDeltas, 0); assert.equal(parser.content, '**正文🙂**\n答案。');
  });
}

test('SSE comments, multiple data lines and CR-only line endings use the same checkpoint boundaries', () => {
  const wire = ': ping\r\rdata: {"choices":\rdata: [{"delta":{"content":"你好🙂"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r';
  const bytes = encoder.encode(wire);
  for (let split = 0; split < bytes.length; split++) {
    let parser = new ProviderStream('openai-chat', true); parser.feed(bytes.subarray(0, split));
    parser = new ProviderStream('openai-chat', true, parser.checkpoint(), parser.content, parser.reasoning);
    parser.feed(bytes.subarray(split)); parser.assertComplete(); assert.equal(parser.content, '你好🙂');
  }
});

test('Responses prefers raw thoughts over duplicated summaries in either arrival order and ignores done echoes', () => {
  for (const channels of [['raw', 'summary'], ['summary', 'raw']]) {
    const parser = new ProviderStream('openai-responses', true);
    for (const channel of channels) parser.feed(encoder.encode(`data: ${JSON.stringify({ type: channel === 'raw' ? 'response.reasoning_text.delta' : 'response.reasoning_summary_text.delta', item_id: 'r', content_index: 0, summary_index: 0, delta: '**思考🙂**' })}\n\n`));
    parser.feed(encoder.encode('data: {"type":"response.reasoning_text.done","text":"**思考🙂**"}\n\n'));
    assert.equal(parser.reasoning, '**思考🙂**');
  }
});

test('malformed UTF-8, oversized incomplete frames and output limits fail explicitly with bounded state', () => {
  const invalid = new ProviderStream('openai-chat', true); invalid.feed(Uint8Array.of(0xc0, 0xaf));
  assert.throws(() => invalid.assertComplete(), /格式无效/);
  const huge = new ProviderStream('openai-chat', true); huge.feed(encoder.encode('data: ' + 'x'.repeat(MAX_EVENT_CHARACTERS + 1)));
  assert.throws(() => huge.assertComplete(), /超过原型限制/); assert.equal(huge.checkpoint().tail, '');
  const limited = new ProviderStream('openai-chat', true);
  limited.feed(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '文'.repeat(99_999) + '🙂' } }] })}\n\n`));
  assert.equal(limited.content, '文'.repeat(99_999)); assert.throws(() => limited.assertComplete(), /100,000/);
});

test('an oversized complete event is rejected before its JSON payload is materialized', () => {
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(encoder.encode(`data: ${JSON.stringify({ diagnostic: 'x'.repeat(MAX_EVENT_CHARACTERS + 1) })}\n\n`));
  assert.throws(() => parser.assertComplete(), /超过原型限制/);
  assert.equal(parser.content, ''); assert.equal(parser.checkpoint().tail, '');
});

test('Responses replaces a previous summary with raw thoughts and preserves Unicode at its limit', () => {
  const parser = new ProviderStream('openai-responses', true);
  const event = (channel: string, delta: string) => encoder.encode(`data: ${JSON.stringify({ type: `response.${channel}.delta`, item_id: 'r', content_index: 0, summary_index: 0, delta })}\n\n`);
  parser.feed(event('reasoning_summary_text', '简短摘要'));
  parser.feed(event('reasoning_text', '完整的思考'));
  assert.equal(parser.reasoning, '完整的思考'); assert.equal(parser.checkpoint().thoughts[0].summary, '');
  const limited = new ProviderStream('openai-responses', true);
  limited.feed(event('reasoning_text', '文'.repeat(99_999) + '🙂'));
  assert.equal(limited.reasoning, '文'.repeat(99_999));
  assert.throws(() => limited.assertComplete(), /100,000/);
});
