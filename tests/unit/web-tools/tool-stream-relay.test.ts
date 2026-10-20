import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupMessage } from '../../../shared/backup/backup';
import type { Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import { addGenerationUsage } from '../../../shared/streaming/generation';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { fixtureStream } from '../../support/providers/tool-turn';
import {
  fragmentedToolBody,
  toolFinalStream,
  toolStream,
} from '../../support/providers/tool-streams';
for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  for (const final of [false, true])
    test(`${provider} single SDK parse keeps continuation private (${final ? 'final answer' : 'tool call'})`, async () => {
      const config = {
        provider,
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture',
        apiKey: 'synthetic-fixture-key',
        systemPrompt: '',
        maxOutputTokens: null,
        modelMetadata: resolveModelMetadata(provider, {
          id: 'fixture',
          name: 'Fixture',
          enabled: true,
          metadataOverrides: { toolCalls: true },
        }),
      };
      const output = await fixtureStream(
        config,
        ['web_search', 'read_webpage'],
        fragmentedToolBody(
          final ? toolFinalStream(provider) : toolStream(provider, { redacted: true, count: 2 }),
          1,
        ),
        new AbortController().signal,
      );
      const parser = new ProviderStream(provider, true),
        reader = output.getReader();
      let wire = '';
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        wire += new TextDecoder().decode(next.value);
        parser.feed(next.value);
        assert.doesNotMatch(
          wire + JSON.stringify(parser.checkpoint()),
          /encrypted-fixture|redacted-fixture|fixture-signature|providerOptions|call_0/,
        );
      }
      parser.assertEnded();
      if (final) {
        parser.assertComplete();
        assert.equal(parser.content, '**工具回答🙂**\n结论。');
      } else {
        assert.equal(output.toolTurn?.calls.length, 2);
        assert.equal(parser.reasoning, provider === 'gemini' ? '' : '检索资料🙂');
      }
    });
}
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
    new TextEncoder().encode('{"type":"usage","usage":{"inputTokens":10,"outputTokens":2}}\n'),
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
