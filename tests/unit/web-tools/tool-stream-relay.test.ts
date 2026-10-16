import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupMessage } from '../../../shared/backup/backup';
import type { Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig } from '../../../shared/providers/types';
import { addGenerationUsage } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { collectProviderToolTurn } from '../../../worker/providers/tool-turn';
import { ToolStreamRelay } from '../../../worker/web-tools/stream-relay';
import {
  fragmentedToolBody,
  toolFinalStream,
  toolStream,
} from '../../support/providers/tool-streams';

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} tool relay preserves private wire bytes and never puts continuation metadata in display frames or partial checkpoints`, async () => {
    const config: ProviderConfig = {
      provider,
      baseUrl: 'https://provider.example/v1',
      model: 'fixture',
      systemPrompt: '',
      maxOutputTokens: null,
      modelMetadata: resolveModelMetadata(provider, {
        id: 'fixture',
        name: 'Fixture',
        enabled: true,
        metadataOverrides: { toolCalls: true },
      }),
    };
    const wire = toolStream(provider, { redacted: true, count: 2 }),
      source: Uint8Array[] = [],
      output: Uint8Array[] = [];
    const display = new ProviderStream('openai-chat', true);
    const relay = new ToolStreamRelay(
      config,
      (bytes) => source.push(bytes),
      (bytes) => {
        output.push(bytes);
        display.feed(bytes);
        assert.doesNotMatch(
          JSON.stringify(display.checkpoint()),
          /encrypted-fixture|redacted-fixture|fixture-signature|providerOptions|call_0/,
        );
      },
    );
    const encoded = new TextEncoder().encode(wire);
    for (let offset = 0; offset < encoded.length; offset += 7)
      relay.add(encoded.subarray(offset, offset + 7));
    relay.end();
    display.assertEnded();
    const original = Buffer.concat(source).toString('utf8');
    assert.equal(original, wire);
    assert.equal(display.reasoning, provider !== 'gemini' ? '检索资料🙂' : '');
    assert.doesNotMatch(
      Buffer.concat(output).toString('utf8'),
      /encrypted-fixture|redacted-fixture|signature|"tool_calls":\[|functionCall|call_0/,
    );
    const turn = await collectProviderToolTurn(
      config,
      ['web_search', 'read_webpage'],
      fragmentedToolBody(original),
      new AbortController().signal,
    );
    assert.equal(turn.calls.length, 2);
  });

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} final tool display streams retain UTF-8, final usage and a completed answer`, () => {
    const display = new ProviderStream('openai-chat', true),
      relay = new ToolStreamRelay(
        { provider },
        () => {},
        (bytes) => display.feed(bytes),
      );
    const bytes = new TextEncoder().encode(toolFinalStream(provider));
    for (const byte of bytes) relay.add(new Uint8Array([byte]));
    relay.end();
    display.assertComplete();
    assert.equal(display.content, '**工具回答🙂**\n结论。');
    assert.equal(display.checkpoint().usage.inputTokens, 10);
    assert.equal(display.checkpoint().usage.outputTokens, 5);
  });

test('large split signatures never enter public pending-event state, and oversize/incomplete private streams cannot invent a completed display', () => {
  const display = new ProviderStream('openai-chat', true),
    output: Uint8Array[] = [];
  const relay = new ToolStreamRelay(
    { provider: 'anthropic' },
    () => {},
    (bytes) => {
      output.push(bytes);
      display.feed(bytes);
    },
  );
  const bytes = new TextEncoder().encode(
    toolStream('anthropic', { signature: Array(6).fill('private-marker-'.repeat(7000)) }),
  );
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    relay.add(bytes.subarray(offset, offset + 16_384));
    assert.doesNotMatch(JSON.stringify(display.checkpoint()), /private-marker/);
  }
  relay.end();
  assert.doesNotMatch(new TextDecoder().decode(Buffer.concat(output)), /private-marker/);
  let writes = 0;
  const oversized = new ToolStreamRelay(
    { provider: 'openai-chat' },
    () => {
      writes++;
    },
    () => {},
  );
  assert.throws(() => oversized.add(new Uint8Array(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.equal(writes, 0);
  const truncated = new ToolStreamRelay(
    { provider: 'openai-chat' },
    () => {},
    () => {},
  );
  truncated.add(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"prefix"}}]}\n\n'));
  assert.throws(() => truncated.end(), /提前结束/);
});

test('multi-step usage and partial backups preserve earlier reported counts and omit overflowing fields', () => {
  assert.deepEqual(
    addGenerationUsage(
      { usage: { inputTokens: 5, outputTokens: 3 }, usageIsFinal: true },
      { usage: { inputTokens: 10, outputTokens: 5 }, usageIsFinal: true },
    ),
    { usage: { inputTokens: 15, outputTokens: 8 }, usageIsFinal: true },
  );
  assert.deepEqual(
    addGenerationUsage(
      { usage: { inputTokens: Number.MAX_SAFE_INTEGER }, usageIsFinal: true },
      { usage: { inputTokens: 1, outputTokens: 2 }, usageIsFinal: true },
    ),
    { usage: { outputTokens: 2 }, usageIsFinal: false },
  );
  const partial = addGenerationUsage(
    { usage: { outputTokens: 3 }, usageIsFinal: true },
    { usage: { inputTokens: 10, outputTokens: 5 }, usageIsFinal: true },
  );
  assert.deepEqual(partial, { usage: { inputTokens: 10, outputTokens: 8 }, usageIsFinal: false });
  assert.equal(
    addGenerationUsage(partial, { usage: { inputTokens: 1, outputTokens: 1 }, usageIsFinal: true })
      .usageIsFinal,
    false,
  );
  assert.deepEqual(
    addGenerationUsage(
      { usage: { totalTokens: 8, inputTokens: 5 }, usageIsFinal: true },
      { usage: { inputTokens: 10 }, usageIsFinal: true },
    ),
    { usage: { totalTokens: 8, inputTokens: 15 }, usageIsFinal: false },
  );
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(
    new TextEncoder().encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'),
  );
  const message: Message = {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [],
    runId: crypto.randomUUID(),
    parentId: null,
    revisionOf: null,
    status: 'running',
    error: null,
    createdAt: 1,
    streamState: parser.checkpoint(),
    tools: { status: 'active', round: 1, calls: [] },
    generation: { usage: { inputTokens: 5, outputTokens: 3 }, usageIsFinal: true },
  };
  const backup = backupMessage(message);
  assert.deepEqual(backup.generation?.usage, { inputTokens: 15, outputTokens: 5 });
  assert.equal(backup.generation?.usageIsFinal, false);
  assert.equal(backup.tools?.status, 'failed');
});
