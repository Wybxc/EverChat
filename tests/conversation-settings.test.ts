import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { applyConversationSettings, conversationSettingsSchema, DEFAULT_CONVERSATION_SETTINGS as defaults, samplingSupport } from '../shared/conversation/settings';
import type { ProviderConfig } from '../shared/providers/types';
import { Autosave } from '../src/autosave';

const config: ProviderConfig = { provider: 'openai-chat', baseUrl: 'https://provider.example/v1', model: 'test-model', systemPrompt: 'model prompt', maxOutputTokens: 128 };

test('conversation settings distinguish inherited, empty and unset values, including zero temperature', () => {
  assert.equal(applyConversationSettings(config, defaults).systemPrompt, 'model prompt');
  assert.equal(applyConversationSettings(config, defaults).maxOutputTokens, 128);
  const explicit = applyConversationSettings(config, { ...defaults, systemPrompt: '', useGlobalMaxOutputTokens: false, maxOutputTokens: null, temperature: 0, topP: 0 });
  assert.equal(explicit.systemPrompt, ''); assert.equal(explicit.maxOutputTokens, null);
  assert.equal(explicit.temperature, 0); assert.equal(explicit.topP, 0);
  assert.equal(applyConversationSettings(config, { ...defaults, systemPrompt: 'conversation prompt', useGlobalMaxOutputTokens: false, maxOutputTokens: 256 }).maxOutputTokens, 256);
});

test('conversation settings reject non-finite numbers, bounds, fractional output limits and unexpected fields', () => {
  for (const patch of [{ temperature: NaN }, { temperature: Infinity }, { temperature: -1 }, { temperature: 3 }, { topP: 1.1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: 100001 }, { apiKey: 'secret' }, { systemPrompt: 'x'.repeat(20001) }]) {
    assert.equal(v.safeParse(conversationSettingsSchema, { ...defaults, ...patch }).success, false);
  }
  assert.equal(v.safeParse(conversationSettingsSchema, { ...defaults, temperature: 0, topP: 1 }).success, true);
});

test('conversation tools default to off and accept only independent, unique read-only tool names', () => {
  assert.deepEqual(defaults.tools, []);
  for (const tools of [[], ['web_search'], ['read_webpage'], ['web_search', 'read_webpage']]) {
    assert.equal(v.safeParse(conversationSettingsSchema, { ...defaults, tools }).success, true);
  }
  for (const tools of [undefined, null, 'web_search', ['web_search', 'web_search'], ['run_command'], ['read_webpage', 'write_file']]) {
    assert.equal(v.safeParse(conversationSettingsSchema, { ...defaults, tools }).success, false);
  }
});

test('reasoning and model sampling gates match current supplier and SDK restrictions', () => {
  const supported = (patch: Partial<ProviderConfig>) => samplingSupport({ ...config, ...patch });
  for (const model of ['o3', 'o4-mini', 'gpt-5-mini', 'gpt-6.1-sol', 'gpt-4o-search-preview']) assert.equal(supported({ model, reasoningEffort: 'none' }).temperatureMax, null);
  assert.equal(supported({ model: 'gpt-5.2', reasoningEffort: 'none' }).temperatureMax, 2);
  assert.equal(supported({ model: 'gpt-6-sol', reasoningEffort: 'none' }).temperatureMax, 2);
  assert.equal(supported({ model: 'gpt-5.2', reasoningEffort: 'high' }).temperatureMax, null);
  for (const model of ['claude-opus-4-7', 'claude-sonnet-5', 'claude-mythos-preview']) assert.equal(supported({ provider: 'anthropic', model }).topPMin, null);
  assert.equal(supported({ provider: 'anthropic', model: 'claude-opus-4-6' }).temperatureMax, 1);
  assert.equal(supported({ provider: 'anthropic', model: 'claude-opus-4-6', reasoningEnabled: true, showReasoning: true }).temperatureMax, null);
  for (const model of ['gemini-3.6-flash', 'gemini-4-pro']) assert.equal(supported({ provider: 'gemini', model }).temperatureMax, null);
  assert.equal(supported({ provider: 'gemini', model: 'gemini-2.5-flash' }).temperatureMax, 2);
  const deepseek = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', reasoningEnabled: true };
  assert.deepEqual(supported(deepseek), { temperatureMax: null, topPMin: 0.95, exclusive: false });
  assert.deepEqual(supported({ ...deepseek, reasoningEffort: 'none' }), { temperatureMax: 2, topPMin: null, exclusive: false });
  assert.equal(supported({ ...deepseek, provider: 'openai-responses' }).topPMin, null);
});

test('hidden sampling values are omitted and effective range conflicts fail before starting a supplier request', () => {
  const preferences = { ...defaults, temperature: 0.7, topP: 0.3 };
  const reasoning = applyConversationSettings({ ...config, model: 'o3' }, preferences);
  assert.equal(reasoning.temperature, undefined); assert.equal(reasoning.topP, undefined);
  assert.throws(() => applyConversationSettings({ ...config, provider: 'anthropic' }, preferences), /只能设置一项/);
  assert.throws(() => applyConversationSettings({ ...config, provider: 'anthropic' }, { ...defaults, temperature: 1.5 }), /不能超过/);
  assert.throws(() => applyConversationSettings({ ...config, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', reasoningEnabled: true }, preferences), /不能低于/);
});

test('remote autosave updates never overwrite dirty local settings or a pending save', async () => {
  let finish!: (value: typeof defaults) => void;
  const store = new Autosave(defaults, () => new Promise<typeof defaults>((resolve) => { finish = resolve; }), () => {}, (_saved, draft) => draft, 60_000);
  try {
    store.receive({ ...defaults, systemPrompt: 'remote' });
    assert.equal(store.getSnapshot().settings.systemPrompt, 'remote');
    store.update({ ...defaults, systemPrompt: 'local' });
    store.receive(defaults); assert.equal(store.getSnapshot().settings.systemPrompt, 'local');
    const saving = store.flush(); store.receive(defaults);
    assert.equal(store.getSnapshot().settings.systemPrompt, 'local');
    finish({ ...defaults, systemPrompt: 'local' }); await saving;
    store.receive({ ...defaults, systemPrompt: 'new remote' });
    assert.equal(store.getSnapshot().settings.systemPrompt, 'new remote');
  } finally { store.dispose(); }
});
