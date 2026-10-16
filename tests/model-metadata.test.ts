import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODEL_METADATA, MAX_MODEL_TOKENS, resolveModelMetadata, validateOutputLimit } from '../shared/model-metadata';
import { chatModels, modelReasoning } from '../shared/models';
import { mergeProviderSettings } from '../shared/provider-settings';
import { runtimeProviderConfig } from '../worker/provider-config';
import { applyConversationSettings, DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import { fetchProviderModels } from '../worker/provider-models';
import { BACKUP_FORMAT, BACKUP_VERSION, validateBackup } from '../shared/backup';
import type { ProviderModel, ProviderSettingsInput } from '../shared/types';

const model: ProviderModel = { id: 'gpt-5.4', name: 'Custom name', enabled: true };
const settings: ProviderSettingsInput = {
  providers: [{ id: crypto.randomUUID(), name: 'Test', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'test-key', models: [model] }],
  activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: null, showReasoning: true,
};
settings.activeProviderId = settings.providers[0].id; settings.activeModel = model.id;
const withModel = (next: ProviderModel): ProviderSettingsInput => ({ ...settings, activeModel: next.id, providers: [{ ...settings.providers[0], models: [next] }] });

test('model metadata resolves each field using manual, provider, catalog then conservative fallback', () => {
  const result = resolveModelMetadata('openai-chat', { ...model,
    reportedMetadata: { contextWindow: 200_000, contextScope: 'input', maxOutputTokens: 4096, imageInput: false, reasoning: false },
    metadataOverrides: { contextWindow: 100_000, imageInput: true }, reasoningSupport: 'supported',
  });
  assert.equal(result.contextWindow, 100_000); assert.equal(result.sources.contextWindow, 'manual');
  assert.equal(result.contextScope, 'input'); assert.equal(result.sources.contextScope, 'provider');
  assert.equal(result.maxOutputTokens, 4096); assert.equal(result.sources.maxOutputTokens, 'provider');
  assert.equal(result.imageInput, true); assert.equal(result.sources.imageInput, 'manual');
  assert.equal(result.reasoning, true); assert.equal(result.sources.reasoning, 'manual');
  assert.equal(result.toolCalls, true); assert.equal(result.sources.toolCalls, 'catalog');
  assert.deepEqual(result.reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
});

test('unmatched IDs and wrong protocols keep their fields unknown', () => {
  for (const [provider, id] of [['openai-chat', 'gpt-9-future'], ['openai-chat', 'constructor'], ['openai-chat', '__proto__'], ['gemini', 'gemini-9-future'], ['anthropic', 'claude-opus-9'], ['anthropic', 'gpt-5.4']] as const) {
    const metadata = resolveModelMetadata(provider, { ...model, id });
    assert.equal(metadata.contextWindow, FALLBACK_MODEL_METADATA.contextWindow);
    assert.equal(metadata.maxOutputTokens, 8192); assert.equal(metadata.reasoning, false);
    assert.equal(metadata.imageInput || metadata.toolCalls || metadata.structuredOutput, false);
    assert.deepEqual(metadata.reasoningEfforts, []);
    assert.ok(Object.values(metadata.sources).every((source) => source === 'fallback'));
  }
  assert.deepEqual(modelReasoning('openai-chat', { ...model, id: 'custom', reasoningSupport: 'supported' }), { supported: true, efforts: ['low', 'medium', 'high'] });
});

test('undefined draft fields restore automatic values without changing sources or clearing known effort arrays', () => {
  const automatic = resolveModelMetadata('openai-chat', model);
  const reset = resolveModelMetadata('openai-chat', { ...model, metadataOverrides: {
    contextWindow: undefined, maxOutputTokens: undefined, contextScope: undefined, imageInput: undefined, toolCalls: undefined, structuredOutput: undefined, reasoningEfforts: undefined,
  }, reportedMetadata: { reasoning: undefined, reasoningEfforts: undefined } });
  assert.deepEqual(reset, automatic);
  assert.deepEqual(resolveModelMetadata('openai-chat', { ...model, id: 'unknown', reasoningSupport: 'supported', metadataOverrides: { reasoningEfforts: undefined } }).reasoningEfforts, ['low', 'medium', 'high']);
});

test('verified model limits and effort levels stay model and protocol specific', () => {
  assert.equal(modelReasoning('openai-chat', { ...model, id: 'gpt-5' }).efforts.includes('none'), false);
  assert.equal(modelReasoning('openai-chat', { ...model, id: 'gpt-6.1-sol' }).efforts.includes('none'), false);
  const deepseek = resolveModelMetadata('openai-chat', { ...model, id: 'deepseek-flash' });
  assert.equal(deepseek.maxOutputTokens, 393216); assert.equal(deepseek.reasoning, true);
  assert.deepEqual(deepseek.reasoningEfforts, ['none', 'low', 'high', 'max']);
  assert.equal(deepseek.structuredOutput, false); // JSON mode does not establish JSON-schema support.
  assert.equal(resolveModelMetadata('openai-chat', { ...model, id: 'gpt-6-astra' }).toolCalls, false);
  assert.equal(resolveModelMetadata('openai-responses', { ...model, id: 'gpt-6-astra' }).toolCalls, true);
  assert.equal(resolveModelMetadata('gemini', { ...model, id: 'gemini-2.5-flash' }).contextScope, 'input');
});

test('reasoning overrides and empty effort lists propagate consistently and accepted configs are independent copies', () => {
  const efforts = ['low', 'high'] as const;
  const configured = withModel({ ...model, metadataOverrides: { reasoningEfforts: [...efforts], maxOutputTokens: 1024 } });
  const config = runtimeProviderConfig(configured, undefined, 'high')!;
  assert.deepEqual(chatModels(configured)[0].metadata, config.modelMetadata);
  assert.equal(runtimeProviderConfig(configured, undefined, 'medium'), null);
  configured.providers[0].models[0].metadataOverrides!.reasoningEfforts!.push('max');
  assert.deepEqual(config.modelMetadata!.reasoningEfforts, [...efforts]);
  assert.equal(config.maxOutputTokens, null); // Descriptive maximum never becomes a request limit.
  const disabled = withModel({ ...model, reasoningSupport: 'unsupported', metadataOverrides: { reasoningEfforts: ['high'] } });
  assert.deepEqual(chatModels(disabled)[0].reasoningEfforts, []); assert.equal(runtimeProviderConfig(disabled, undefined, 'high'), null);
  const noControl = withModel({ ...model, metadataOverrides: { reasoningEfforts: [] } });
  assert.equal(runtimeProviderConfig(noControl)?.reasoningEnabled, true); assert.equal(runtimeProviderConfig(noControl, undefined, 'high'), null);
});

test('model metadata rejects invalid limits, capability values, duplicate efforts and nested unexpected fields', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, MAX_MODEL_TOKENS + 1, '1000', null]) {
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      assert.throws(() => mergeProviderSettings(settings, withModel({ ...model, metadataOverrides: { [field]: value } } as ProviderModel)), /Token/);
      assert.throws(() => mergeProviderSettings(settings, withModel({ ...model, reportedMetadata: { [field]: value } } as ProviderModel)), /Token/);
    }
  }
  for (const patch of [{ imageInput: 'yes' }, { contextScope: 'total' }, { reasoningEfforts: ['high', 'high'] }, { reasoningEfforts: ['ultra'] }, { apiKey: 'secret' }, { reasoning: true }]) {
    assert.throws(() => mergeProviderSettings(settings, withModel({ ...model, metadataOverrides: patch } as ProviderModel)));
  }
  const normalized = mergeProviderSettings(settings, withModel({ ...model, metadataOverrides: { contextWindow: MAX_MODEL_TOKENS, imageInput: false, reasoningEfforts: [] } }));
  assert.equal(normalized.providers[0].models[0].metadataOverrides!.contextWindow, MAX_MODEL_TOKENS);
});

test('endpoint changes invalidate provider-reported metadata but retain manual values', () => {
  const original = withModel({ ...model, reportedMetadata: { contextWindow: 200000 }, metadataOverrides: { imageInput: false } });
  const input = { ...original, providers: [{ ...original.providers[0], baseUrl: 'https://other.example/v1' }] };
  const result = mergeProviderSettings(original, input).providers[0].models[0];
  assert.equal(result.reportedMetadata, undefined); assert.deepEqual(result.metadataOverrides, { imageInput: false });
  assert.deepEqual(mergeProviderSettings(original, original).providers[0].models[0].reportedMetadata, { contextWindow: 200000 });
  const restored = mergeProviderSettings(original, input, { restoreModelMetadata: true });
  assert.deepEqual(restored.providers[0].models[0].reportedMetadata, { contextWindow: 200000 });
  assert.deepEqual(restored.providers[0].models[0].metadataOverrides, { imageInput: false });
});

test('only authoritative explicit output limits are checked and unset limits survive conversation overrides', () => {
  const known = runtimeProviderConfig(withModel({ ...model, metadataOverrides: { contextWindow: 4096, maxOutputTokens: 1024 } }))!;
  assert.equal(applyConversationSettings(known, DEFAULT_CONVERSATION_SETTINGS).maxOutputTokens, null);
  assert.throws(() => applyConversationSettings({ ...known, maxOutputTokens: 1025 }, DEFAULT_CONVERSATION_SETTINGS), /1,024/);
  assert.equal(applyConversationSettings({ ...known, maxOutputTokens: 1025 }, { ...DEFAULT_CONVERSATION_SETTINGS, useGlobalMaxOutputTokens: false, maxOutputTokens: null }).maxOutputTokens, null);
  assert.throws(() => applyConversationSettings(known, { ...DEFAULT_CONVERSATION_SETTINGS, useGlobalMaxOutputTokens: false, maxOutputTokens: 1025 }), /1,024/);
  const fallback = resolveModelMetadata('openai-chat', { ...model, id: 'unknown' });
  assert.doesNotThrow(() => validateOutputLimit(fallback, 100000));
  const shared = resolveModelMetadata('openai-chat', { ...model, metadataOverrides: { contextWindow: 1024, maxOutputTokens: 4096 } });
  assert.throws(() => validateOutputLimit(shared, 2048), /上下文/);
  assert.doesNotThrow(() => validateOutputLimit({ ...shared, contextScope: 'input' }, 2048));
});

test('Claude model discovery preserves native limits and explicit false support and paginates safely', async (t) => {
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString()); pages++;
    if (pages === 1) return Response.json({ data: [{ id: 'claude-test', display_name: 'Claude Test', max_input_tokens: 200000, max_tokens: 64000,
      capabilities: { image_input: { supported: true }, structured_outputs: { supported: false }, thinking: { supported: true },
        effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } }, server_tools: { supported: true } },
    }], has_more: true, last_id: 'claude-test' });
    assert.equal(url.searchParams.get('after_id'), 'claude-test');
    return Response.json({ data: [{ id: 'claude-test' }, { id: 'claude-invalid', max_input_tokens: 0, max_tokens: Infinity, capabilities: { thinking: { supported: false }, effort: { supported: false } } }], has_more: false });
  });
  const found = await fetchProviderModels({ ...settings.providers[0], provider: 'anthropic' });
  assert.equal(pages, 2);
  assert.deepEqual(found, [
    { id: 'claude-invalid', name: 'claude-invalid', reportedMetadata: { reasoning: false, reasoningEfforts: [] } },
    { id: 'claude-test', name: 'Claude Test', reportedMetadata: { contextWindow: 200000, contextScope: 'input', maxOutputTokens: 64000, imageInput: true, structuredOutput: false, reasoning: true, reasoningEfforts: ['low', 'high'] } },
  ]);
  assert.equal(found[1].reportedMetadata!.toolCalls, undefined);
});

test('Gemini model discovery filters embedding models and retains valid limits, display names and thinking fields', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [
    { name: 'models/gemini-custom', displayName: 'Gemini Custom', inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true, supportedGenerationMethods: ['generateContent'], apiKey: 'secret' },
    { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'], inputTokenLimit: 4096 },
    { name: 'models/invalid', inputTokenLimit: -1, outputTokenLimit: MAX_MODEL_TOKENS + 1, thinking: 'yes' },
    { name: 'models/not a model' },
  ] }));
  assert.deepEqual(await fetchProviderModels({ ...settings.providers[0], provider: 'gemini' }), [
    { id: 'gemini-custom', name: 'Gemini Custom', reportedMetadata: { contextWindow: 1048576, contextScope: 'input', maxOutputTokens: 65536, reasoning: true } },
    { id: 'invalid', name: 'invalid' },
  ]);
});

test('OpenAI-compatible discovery does not treat arbitrary upstream fields as native capabilities', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'custom', max_tokens: 1024, inputTokenLimit: 100, capabilities: { thinking: { supported: true } }, apiKey: 'secret' }] }));
  assert.deepEqual(await fetchProviderModels(settings.providers[0]), [{ id: 'custom', name: 'custom' }]);
});

test('backups preserve validated metadata and strip model-level secrets while rejecting nested secrets and invalid metadata', () => {
  const configured = withModel({ ...model, reportedMetadata: { contextWindow: 200000, reasoning: true }, metadataOverrides: { maxOutputTokens: 1024, imageInput: false, reasoningEfforts: ['low', 'high'] } });
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 1,
    conversation: { id: crypto.randomUUID(), title: 'Backup', createdAt: 1, updatedAt: 1, messages: [] },
    settings: { ...configured, promptPresets: [] },
  };
  const restored = validateBackup(backup);
  assert.deepEqual(restored.settings.providers[0].models[0], configured.providers[0].models[0]);
  assert.equal(JSON.stringify(restored).includes('test-key'), false);
  const input = structuredClone(backup);
  Object.assign(input.settings.providers[0].models[0], { apiKey: 'unexpected' });
  assert.equal(JSON.stringify(validateBackup(input)).includes('unexpected'), false);
  Object.assign(input.settings.providers[0].models[0].metadataOverrides!, { apiKey: 'nested' });
  assert.throws(() => validateBackup(input), /模型配置/);
});
