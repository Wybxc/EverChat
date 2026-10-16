import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { assertImageContext, type ImagePart } from '../../../shared/attachments/images';
import { buildContext, contextEstimateSchema } from '../../../shared/conversation/context-budget';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import {
  enrichModelCatalog,
  matchModelCatalog,
  parseModelCatalog,
  type ModelCatalog,
} from '../../../shared/models/catalog';
import { canAttemptCapability, resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderModel } from '../../../shared/models/types';
import { mergeProviderSettings, modelSchema } from '../../../shared/providers/settings';
import type { ProviderSettingsInput } from '../../../shared/providers/types';
import { assertWebToolSupport } from '../../../shared/web-tools/tasks';
import { providerCallOptions } from '../../../worker/providers/sdk';

const model: ProviderModel = { id: 'catalog-fixture', name: 'My model', enabled: true };
const raw = {
  openai: {
    models: {
      'catalog-fixture': {
        tool_call: true,
        reasoning: true,
        structured_output: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'invented'] }],
      },
    },
  },
};
const catalog = parseModelCatalog(raw);
test('the public catalog retains only explicit bounded capability data and ignores non-chat models', () => {
  assert.deepEqual(catalog.openai['catalog-fixture'], {
    toolCalls: true,
    reasoning: true,
    structuredOutput: false,
    imageInput: true,
    contextWindow: 131072,
    contextScope: 'combined',
    maxOutputTokens: 8192,
    reasoningEfforts: ['low', 'high'],
  });
  const malicious = JSON.parse('{"__proto__":{"tool_call":true},"constructor":{"tool_call":true}}');
  const parsed = parseModelCatalog({
    openai: {
      models: {
        ...malicious,
        missing: {
          reasoning: true,
          limit: { context: -1, input: Infinity, output: 10_000_001 },
          apiKey: 'secret',
        },
        imageOnly: { tool_call: true, modalities: { output: ['image'] } },
        'bad id': { tool_call: true },
        native: {
          reasoning_options: [],
          tool_call: false,
          modalities: { input: ['text'] },
          limit: { context: 200000, input: 150000, output: 5000 },
        },
      },
    },
    unknownVendor: raw.openai,
  });
  assert.deepEqual(parsed, {
    openai: {
      missing: { reasoning: true },
      native: {
        toolCalls: false,
        imageInput: false,
        contextWindow: 150000,
        contextScope: 'input',
        maxOutputTokens: 5000,
        reasoningEfforts: [],
      },
    },
  });
  assert.equal({}.hasOwnProperty('toolCalls'), false);
});
test('exact matches have limits; boundary-aware longest aliases inherit flags without inventing controls or limits', () => {
  assert.equal(matchModelCatalog('openai-chat', 'CATALOG-FIXTURE', catalog)?.match, 'exact');
  for (const id of [
    'catalog-fixture-2026-10-15',
    'gateway/catalog-fixture',
    'ft:catalog-fixture:org:custom',
  ]) {
    assert.deepEqual(matchModelCatalog('openai-responses', id, catalog), {
      match: 'alias',
      values: { imageInput: true, toolCalls: true, reasoning: true, structuredOutput: false },
    });
  }
  assert.equal(matchModelCatalog('openai-chat', 'catalog-fixtureevil', catalog), undefined);
  assert.equal(matchModelCatalog('anthropic', 'catalog-fixture', catalog), undefined);
  assert.equal(matchModelCatalog('gemini', 'catalog-fixture', catalog), undefined);
  const families: ModelCatalog = {
    openai: { gpt: { reasoning: true }, 'gpt-special': { reasoning: false } },
  };
  assert.equal(
    matchModelCatalog('openai-chat', 'gpt-special-next', families)?.values.reasoning,
    false,
  );
});
test('new directory models are usable offline and have explicit sources; aliases do not send guessed reasoning controls', () => {
  const known = resolveModelMetadata('anthropic', { ...model, id: 'claude-sonnet-4-5' });
  assert.ok(known.contextWindow > 32768);
  assert.equal(known.imageInput, true);
  assert.equal(known.sources.imageInput, 'directory');
  const alias = resolveModelMetadata('openai-chat', { ...model, id: 'gpt-5.4-custom' });
  assert.equal(alias.imageInput, true);
  assert.equal(alias.sources.imageInput, 'inferred');
  assert.equal(alias.sources.contextWindow, 'fallback');
  assert.deepEqual(alias.reasoningEfforts, []);
  for (const [provider, id, baseUrl] of [
    ['anthropic', 'claude-sonnet-4-5', 'https://api.anthropic.com/v1'],
    ['openai-chat', 'deepseek-flash-custom', 'https://api.deepseek.com/v1'],
    ['openai-responses', 'gateway/gpt-5.4', 'https://provider.test/v1'],
  ] as const) {
    const modelMetadata = resolveModelMetadata(provider, { ...model, id });
    const options = providerCallOptions(
      {
        provider,
        model: id,
        baseUrl,
        modelMetadata,
        reasoningEnabled: true,
        showReasoning: true,
        systemPrompt: '',
        maxOutputTokens: null,
      },
      [],
      new AbortController().signal,
    );
    const serialized = JSON.stringify(options);
    assert.equal(options.reasoning, undefined);
    assert.ok(!serialized.includes('adaptive'));
    assert.ok(!serialized.includes('forceReasoning'));
    assert.ok(!serialized.includes('"thinking"'));
  }
});
test('manual and native facts precede positive tests, local corrections and public directory; drafts remain intact', () => {
  const enriched = enrichModelCatalog(
    'openai-chat',
    {
      ...model,
      metadataOverrides: { imageInput: false },
      systemPrompt: 'keep',
      useGlobalSystemPrompt: false,
    },
    catalog,
    1000,
  );
  assert.equal(enriched.name, model.name);
  assert.equal(enriched.systemPrompt, 'keep');
  assert.equal(enriched.enabled, true);
  assert.equal(enrichModelCatalog('openai-chat', enriched, catalog, 1000), enriched);
  const tested = {
    ...enriched,
    testedCapabilities: { imageInput: true as const, toolCalls: true as const, testedAt: 2000 },
  };
  assert.equal(resolveModelMetadata('openai-chat', tested).sources.imageInput, 'manual');
  const automatic = resolveModelMetadata('openai-chat', {
    ...tested,
    metadataOverrides: undefined,
    reportedMetadata: { toolCalls: false },
  });
  assert.equal(automatic.sources.imageInput, 'tested');
  assert.equal(automatic.imageInput, true);
  assert.equal(automatic.sources.toolCalls, 'provider');
  assert.equal(automatic.toolCalls, false);
  const corrected = resolveModelMetadata('openai-chat', {
    ...model,
    id: 'deepseek-flash',
    directoryMetadata: { values: { structuredOutput: true }, match: 'exact', updatedAt: 1000 },
  });
  assert.equal(corrected.structuredOutput, false);
  assert.equal(corrected.sources.structuredOutput, 'catalog');
  const context = buildContext(
    [],
    'hello',
    { systemPrompt: '', maxOutputTokens: null, modelMetadata: automatic },
    DEFAULT_CONVERSATION_SETTINGS,
  ).estimate;
  assert.equal(context.windowSource, 'directory');
  assert.ok(v.safeParse(contextEstimateSchema, context).success);
});
test('unknown and inferred capabilities permit user choices while explicit negatives still block both image and tool paths', () => {
  const unknown = resolveModelMetadata('openai-chat', model);
  assert.equal(canAttemptCapability(unknown, 'imageInput'), true);
  assert.equal(canAttemptCapability(unknown, 'toolCalls'), true);
  assert.doesNotThrow(() => assertWebToolSupport(unknown, ['web_search']));
  const image: ImagePart = {
    type: 'image',
    attachmentId: crypto.randomUUID(),
    name: 'test.png',
    size: 100,
    mediaType: 'image/png',
    sha256: 'a'.repeat(64),
  };
  const messages = [{ role: 'user' as const, content: '', images: [image] }];
  assert.doesNotThrow(() => assertImageContext(messages, { modelMetadata: unknown }));
  for (const negative of [
    { ...model, metadataOverrides: { imageInput: false, toolCalls: false } },
    { ...model, reportedMetadata: { imageInput: false, toolCalls: false } },
    {
      ...model,
      directoryMetadata: {
        values: { imageInput: false, toolCalls: false },
        match: 'exact' as const,
        updatedAt: 1000,
      },
    },
  ]) {
    const metadata = resolveModelMetadata('openai-chat', negative);
    assert.throws(() => assertImageContext(messages, { modelMetadata: metadata }), /不支持图片/);
    assert.throws(() => assertWebToolSupport(metadata, ['web_search']), /不支持工具/);
  }
});
test('evidence is strictly validated and connection edits invalidate automatic facts without touching manual values or keys', () => {
  const enriched = {
    ...enrichModelCatalog('openai-chat', model, catalog, 1000),
    testedCapabilities: { imageInput: true as const, testedAt: 2000 },
    metadataOverrides: { imageInput: false },
  };
  assert.deepEqual(v.parse(modelSchema, enriched), enriched);
  for (const patch of [
    { testedCapabilities: { imageInput: false, testedAt: 1 } },
    { testedCapabilities: { toolCalls: true, testedAt: -1 } },
    { directoryMetadata: { ...enriched.directoryMetadata, apiKey: 'secret' } },
  ]) {
    assert.equal(v.safeParse(modelSchema, { ...enriched, ...patch }).success, false);
  }
  const settings: ProviderSettingsInput = {
    providers: [
      {
        id: crypto.randomUUID(),
        name: 'provider',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'private',
        models: [enriched],
      },
    ],
    activeProviderId: null,
    activeModel: '',
    systemPrompt: '',
    maxOutputTokens: null,
    showReasoning: false,
  };
  const edited = mergeProviderSettings(settings, {
    ...settings,
    providers: [{ ...settings.providers[0], baseUrl: 'https://provider.test/v2' }],
  });
  assert.equal(edited.providers[0].apiKey, 'private');
  assert.deepEqual(edited.providers[0].models[0].metadataOverrides, { imageInput: false });
  assert.equal(edited.providers[0].models[0].directoryMetadata, undefined);
  assert.equal(edited.providers[0].models[0].testedCapabilities, undefined);
  const rekeyed = mergeProviderSettings(settings, {
    ...settings,
    providers: [{ ...settings.providers[0], apiKey: 'replacement' }],
  });
  assert.equal(rekeyed.providers[0].models[0].testedCapabilities, undefined);
  assert.deepEqual(rekeyed.providers[0].models[0].directoryMetadata, enriched.directoryMetadata);
  const restored = mergeProviderSettings(settings, settings, { restoreModelMetadata: true });
  assert.deepEqual(restored.providers[0].models, [enriched]);
});
