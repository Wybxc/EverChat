import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderUsage } from '../../../worker/providers/stream-usage';
import { mcpUsage } from '../../../shared/usage/evidence';
import { addGenerationUsage } from '../../../shared/streaming/generation';
import { ProviderStream, encodeGenerationEvent } from '../../../shared/streaming/provider-stream';

test('Gemini only-total, only-prompt and explicit-zero reports retain evidence without SDK default zeros', () => {
  const onlyTotal = new ProviderUsage();
  assert.equal(
    onlyTotal.observe(
      { usageMetadata: { totalTokenCount: 12 }, candidates: [{ finishReason: 'STOP' }] },
      'gemini',
    ),
    true,
  );
  onlyTotal.mergeSdk({
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  });
  assert.deepEqual(onlyTotal.usage, { totalTokens: 12 });
  const total = addGenerationUsage(undefined, {
    usage: onlyTotal.usage,
    usageIsFinal: true,
    usageSources: onlyTotal.sources,
  });
  const result = mcpUsage(total.usage, total.usageSources, total.usageCoverage, 1, true, true);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.totalTokens, 12);
  assert.equal(result.dimensions.totalTokens.source, 'provider_reported');
  assert.equal(result.finalized, true);
  assert.equal(result.completeness, 'partial');
  const prompt = new ProviderUsage();
  assert.equal(prompt.observe({ usageMetadata: { promptTokenCount: 8 } }, 'gemini'), true);
  assert.equal(prompt.usage.inputTokens, 8);
  assert.equal(prompt.sources.inputTokens, 'derived');
  const zeros = new ProviderUsage();
  zeros.observe(
    { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 12 } },
    'gemini',
  );
  const zero = addGenerationUsage(undefined, {
    usage: zeros.usage,
    usageSources: zeros.sources,
    usageIsFinal: true,
  });
  const inconsistent = mcpUsage(zero.usage, zero.usageSources, zero.usageCoverage, 1, true, true);
  assert.equal(inconsistent.inputTokens, 0);
  assert.equal(inconsistent.outputTokens, 0);
  assert.equal(inconsistent.totalTokens, 12);
  assert.deepEqual(inconsistent.warnings, ['inconsistent_usage']);
});

test('multi-step MCP usage distinguishes complete totals from known subtotals and durable source metadata', () => {
  const parser = new ProviderStream('openai-chat', true);
  parser.feed(
    encodeGenerationEvent({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      usageSources: {
        inputTokens: 'provider_reported',
        outputTokens: 'provider_reported',
        totalTokens: 'provider_reported',
      },
    }),
  );
  const state = parser.checkpoint();
  const first = addGenerationUsage(undefined, {
    usage: state.usage,
    usageSources: state.usageSources,
    usageIsFinal: true,
  });
  const second = addGenerationUsage(first, {
    usage: { totalTokens: 5 },
    usageSources: { totalTokens: 'provider_reported' },
    usageIsFinal: true,
  });
  const result = mcpUsage(
    second.usage,
    second.usageSources,
    second.usageCoverage,
    2,
    second.usageIsFinal,
    true,
  );
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.totalTokens, 17);
  assert.equal(result.dimensions.inputTokens.knownSubtotal, 10);
  assert.equal(result.dimensions.inputTokens.reportedSteps, 1);
  assert.equal(result.dimensions.inputTokens.expectedSteps, 2);
  assert.equal(result.finalized, true);
  assert.equal(result.completeness, 'partial');
  assert.equal(
    mcpUsage({ inputTokens: 0 }, undefined, undefined, 0, false, true).inputTokens,
    null,
    'do not invent evidence for legacy data',
  );
  const resumed = new ProviderStream('openai-chat', true, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(resumed.checkpoint().usageSources, state.usageSources);
});
