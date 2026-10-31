import type { ProviderSettings } from '../../../shared/providers/types';

export function availableModels(settings: ProviderSettings) {
  return settings.providers.flatMap((profile) =>
    profile.enabled !== false && (profile.hasApiKey || profile.apiKey?.trim())
      ? profile.models
          .filter((model) => model.enabled && model.id.trim())
          .map((model) => ({ profile, model }))
      : [],
  );
}
export function reconcile(settings: ProviderSettings, chooseIfEmpty = false): ProviderSettings {
  const models = availableModels(settings);
  if (
    models.some(
      ({ profile, model }) =>
        profile.id === settings.activeProviderId && model.id === settings.activeModel,
    )
  )
    return settings;
  if (!settings.activeProviderId && !chooseIfEmpty) return settings;
  return {
    ...settings,
    activeProviderId: models[0]?.profile.id ?? null,
    activeModel: models[0]?.model.id ?? '',
  };
}
