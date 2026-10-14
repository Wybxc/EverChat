import type { ChatModel, ProviderApiKind, ProviderModel, ProviderSettings, ProviderSettingsInput, ReasoningEffort } from './types';
import { resolveModelMetadata } from './model-metadata';

export const effortLabels: Record<ReasoningEffort, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高',
};

export function modelReasoning(provider: ProviderApiKind, model: ProviderModel) {
  const metadata = resolveModelMetadata(provider, model);
  return { supported: metadata.reasoning, efforts: metadata.reasoningEfforts };
}

export function chatModels(settings: ProviderSettings | ProviderSettingsInput): ChatModel[] {
  return settings.providers.flatMap((profile) => profile.apiKey || ('hasApiKey' in profile && profile.hasApiKey)
    ? profile.models.filter((model) => model.enabled).map((model) => {
      const metadata = resolveModelMetadata(profile.provider, model);
      return {
      providerId: profile.id, providerName: profile.name, model: model.id, name: model.name || model.id,
      provider: profile.provider, baseUrl: profile.baseUrl,
      ...(model.useGlobalSystemPrompt === false ? { systemPrompt: model.systemPrompt ?? '' } : {}),
      reasoningSupported: metadata.reasoning, reasoningEfforts: metadata.reasoningEfforts, metadata,
    }; }) : []);
}

export const modelSelectionKey = (selection: { providerId: string; model: string }) => JSON.stringify([selection.providerId, selection.model]);
