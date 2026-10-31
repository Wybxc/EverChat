import { AppError, problem } from '../../shared/errors/descriptor';
import { resolveModelMetadata } from '../../shared/models/metadata';
import type { ModelSelection } from '../../shared/models/types';
import { providerOptions } from '../../shared/providers/endpoints';
import { providerTypes } from '../../shared/providers/settings';
import type {
  ProviderApiKind,
  ProviderConfig,
  ProviderKind,
  ProviderProfileInput,
  ProviderSettings,
  ProviderSettingsInput,
} from '../../shared/providers/types';
import type { Env } from '../http/env';
export {
  mergeProviderSettings,
  normalizeBaseUrl,
  providerSettingsSchema,
} from '../../shared/providers/settings';

function normalizeProvider(value: string | undefined): ProviderKind {
  if (providerTypes.includes(value as ProviderApiKind)) return value as ProviderKind;
  throw new AppError(problem('PROVIDER_FAILED'), 'AI_PROVIDER 配置无效。');
}

export function providerConfigFromEnv(env: Env): ProviderConfig | null {
  if (!env.AI_PROVIDER) return null;
  const provider = normalizeProvider(env.AI_PROVIDER);
  const defaults = providerOptions.find((option) => option.value === provider);
  const maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS);
  return {
    provider,
    baseUrl: env.AI_BASE_URL?.trim().replace(/\/+$/, '') || defaults?.baseUrl || '',
    model: env.AI_MODEL?.trim() || '',
    systemPrompt:
      env.SYSTEM_PROMPT ??
      'You are a clear, helpful assistant. Respond in the language of the user’s request.',
    maxOutputTokens:
      Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    apiKey: env.AI_API_KEY?.trim() || undefined,
  };
}

export function defaultProviderSettings(env: Env): ProviderSettingsInput {
  const config = providerConfigFromEnv(env);
  const profileId = '00000000-0000-4000-8000-000000000001';
  if (!config) {
    const limit = Number(env.MAX_OUTPUT_TOKENS);
    return {
      providers: [],
      activeProviderId: null,
      activeModel: '',
      systemPrompt:
        env.SYSTEM_PROMPT ??
        'You are a clear, helpful assistant. Respond in the language of the user’s request.',
      maxOutputTokens: Number.isInteger(limit) && limit > 0 ? limit : null,
    };
  }
  const option = providerOptions.find((item) => item.value === config.provider)!;
  const profile: ProviderProfileInput = {
    id: profileId,
    name: option.label,
    provider: config.provider,
    baseUrl: config.baseUrl,
    models: config.model ? [{ id: config.model, name: config.model, enabled: true }] : [],
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
  return {
    providers: [profile],
    activeProviderId: config.model && config.apiKey ? profileId : null,
    activeModel: config.model && config.apiKey ? config.model : '',
    systemPrompt: config.systemPrompt,
    maxOutputTokens: config.maxOutputTokens,
  };
}

export function publicProviderSettings(settings: ProviderSettingsInput): ProviderSettings {
  return {
    ...settings,
    providers: settings.providers.map((profile) => ({
      ...profile,
      hasApiKey: Boolean(profile.apiKey),
    })),
  };
}

export function runtimeProviderConfig(
  settings: ProviderSettingsInput,
  selection?: ModelSelection,
  effort?: ProviderConfig['reasoningEffort'],
): ProviderConfig | null {
  const providerId = selection?.providerId ?? settings.activeProviderId;
  const modelId = selection?.model ?? settings.activeModel;
  const selected =
    providerId && modelId
      ? settings.providers.find((profile) => profile.id === providerId && profile.enabled !== false)
      : undefined;
  const model = selected?.models.find((model) => model.id === modelId && model.enabled);
  if (selected?.apiKey && model) {
    const metadata = resolveModelMetadata(selected.provider, model);
    if (effort && (!metadata.reasoning || !metadata.reasoningEfforts.includes(effort))) return null;
    return {
      provider: selected.provider,
      providerId: selected.id,
      providerName: selected.name,
      baseUrl: selected.baseUrl,
      model: model.id,
      modelName: model.name || model.id,
      systemPrompt:
        model.useGlobalSystemPrompt === false ? (model.systemPrompt ?? '') : settings.systemPrompt,
      reasoningEnabled: metadata.reasoning,
      modelMetadata: metadata,
      reasoningEffort: effort,
      maxOutputTokens: settings.maxOutputTokens,
      apiKey: selected.apiKey,
    };
  }
  return null;
}
