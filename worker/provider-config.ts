import type { ModelSelection, ProviderApiKind, ProviderConfig, ProviderKind, ProviderProfileInput, ProviderSettings, ProviderSettingsInput } from '../shared/types';
import { modelReasoning } from '../shared/models';
import { providerOptions } from '../shared/providers';
import type { Env } from './env';
import { migrateModels, providerTypes } from '../shared/provider-settings';
export { normalizeBaseUrl, providerSettingsSchema, mergeProviderSettings } from '../shared/provider-settings';

export function normalizeProvider(value: string | undefined): ProviderKind {
  if (value === 'openai-compatible') return 'openai-chat';
  if (providerTypes.includes(value as ProviderApiKind)) return value as ProviderKind;
  throw new Error('AI_PROVIDER 配置无效。');
}

export function providerConfigFromEnv(env: Env): ProviderConfig | null {
  // Retire the old environment setting without preventing existing installations from logging in.
  if (!env.AI_PROVIDER || env.AI_PROVIDER === 'demo') return null;
  const provider = normalizeProvider(env.AI_PROVIDER);
  const defaults = providerOptions.find((option) => option.value === provider);
  const maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS);
  return {
    provider,
    baseUrl: env.AI_BASE_URL?.trim().replace(/\/+$/, '') || defaults?.baseUrl || '',
    model: env.AI_MODEL?.trim() || '',
    systemPrompt: env.SYSTEM_PROMPT ?? '你是一位清晰、友善的助手。请默认使用中文回答。',
    maxOutputTokens: Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    apiKey: env.AI_API_KEY?.trim() || undefined,
  };
}

export function defaultProviderSettings(env: Env): ProviderSettingsInput {
  const config = providerConfigFromEnv(env);
  const profileId = '00000000-0000-4000-8000-000000000001';
  if (!config) {
    const limit = Number(env.MAX_OUTPUT_TOKENS);
    return {
      providers: [], activeProviderId: null, activeModel: '',
      systemPrompt: env.SYSTEM_PROMPT ?? '你是一位清晰、友善的助手。请默认使用中文回答。',
      maxOutputTokens: Number.isInteger(limit) && limit > 0 ? limit : null, showReasoning: false,
    };
  }
  const option = providerOptions.find((item) => item.value === config.provider)!;
  const profile: ProviderProfileInput = {
    id: profileId, name: option.label, provider: config.provider, baseUrl: config.baseUrl,
    models: migrateModels(config.model ? [config.model] : []), ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
  return {
    providers: [profile], activeProviderId: config.model && config.apiKey ? profileId : null,
    activeModel: config.model && config.apiKey ? config.model : '', systemPrompt: config.systemPrompt,
    maxOutputTokens: config.maxOutputTokens, showReasoning: false,
  };
}

export function publicProviderSettings(settings: ProviderSettingsInput): ProviderSettings {
  return {
    ...settings,
    providers: settings.providers.map((profile) => ({ ...profile, hasApiKey: Boolean(profile.apiKey) })),
  };
}

export function legacyProviderSettings(config: Omit<ProviderConfig, 'provider'> & { provider: string }): ProviderSettingsInput {
  const profileId = '00000000-0000-4000-8000-000000000001';
  const option = providerOptions.find((item) => item.value === config.provider);
  if (!option) return { providers: [], activeProviderId: null, activeModel: '', systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens, showReasoning: false };
  return {
    providers: [{ id: profileId, name: option.label, provider: option.value, baseUrl: config.baseUrl,
      models: migrateModels(config.model ? [config.model] : []), ...(config.apiKey ? { apiKey: config.apiKey } : {}) }],
    activeProviderId: config.model && config.apiKey ? profileId : null,
    activeModel: config.model && config.apiKey ? config.model : '',
    systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens, showReasoning: false,
  };
}

export function runtimeProviderConfig(settings: ProviderSettingsInput, selection?: ModelSelection, effort?: ProviderConfig['reasoningEffort']): ProviderConfig | null {
  const providerId = selection?.providerId ?? settings.activeProviderId;
  const modelId = selection?.model ?? settings.activeModel;
  const selected = providerId && modelId
    ? settings.providers.find((profile) => profile.id === providerId)
    : undefined;
  const model = selected?.models.find((model) => model.id === modelId && model.enabled);
  if (selected?.apiKey && model) {
    const reasoning = modelReasoning(selected.provider, model);
    if (effort && (!reasoning.supported || !reasoning.efforts.includes(effort))) return null;
    return { provider: selected.provider, providerId: selected.id, baseUrl: selected.baseUrl, model: model.id, modelName: model.name || model.id,
      systemPrompt: model.useGlobalSystemPrompt === false ? model.systemPrompt ?? '' : settings.systemPrompt,
      reasoningEnabled: reasoning.supported,
      reasoningEffort: effort,
      maxOutputTokens: settings.maxOutputTokens, showReasoning: settings.showReasoning, apiKey: selected.apiKey };
  }
  return null;
}
