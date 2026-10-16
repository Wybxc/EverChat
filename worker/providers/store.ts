import { MAX_BACKUP_BYTES, type BackupSettings } from '../../shared/backup/backup';
import { chatModels } from '../../shared/models/selection';
import type { ModelSelection, ReasoningEffort } from '../../shared/models/types';
import type { PromptPreset } from '../../shared/presets/types';
import type {
  ProviderConfig,
  ProviderModelConfig,
  ProviderSettings,
  ProviderSettingsInput,
} from '../../shared/providers/types';
import type { Env } from '../http/env';
import { HttpError, json, readJsonStream } from '../http/response';
import { PromptPresetError, PromptPresets } from '../presets/store';
import {
  defaultProviderSettings,
  mergeProviderSettings,
  publicProviderSettings,
  runtimeProviderConfig,
} from '../providers/config';

export class ProviderSettingsStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
    private readonly presets: PromptPresets,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, baseUrl TEXT NOT NULL,
      models TEXT NOT NULL, apiKey TEXT
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1), activeProviderId TEXT, activeModel TEXT NOT NULL,
      systemPrompt TEXT NOT NULL, maxOutputTokens INTEGER NOT NULL
    )`);
  }
  providerSettingsData(): ProviderSettingsInput {
    const preferences = this.storage.sql
      .exec<
        {
          activeProviderId: string | null;
          activeModel: string;
          systemPrompt: string;
          maxOutputTokens: number;
        } & Record<string, SqlStorageValue>
      >(
        'SELECT activeProviderId, activeModel, systemPrompt, maxOutputTokens FROM provider_preferences WHERE id = 1',
      )
      .toArray()[0];
    const profiles = this.storage.sql
      .exec<
        {
          id: string;
          name: string;
          provider: ProviderModelConfig['provider'];
          baseUrl: string;
          models: string;
          apiKey: string | null;
        } & Record<string, SqlStorageValue>
      >('SELECT id, name, provider, baseUrl, models, apiKey FROM provider_profiles ORDER BY rowid')
      .toArray();
    if (preferences || profiles.length) {
      const defaults = defaultProviderSettings(this.env);
      return {
        providers: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          models: JSON.parse(profile.models),
          ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        })),
        activeProviderId: preferences?.activeProviderId ?? null,
        activeModel: preferences?.activeModel ?? '',
        systemPrompt: preferences?.systemPrompt ?? defaults.systemPrompt,
        maxOutputTokens: Number(preferences?.maxOutputTokens ?? defaults.maxOutputTokens) || null,
      };
    }
    return defaultProviderSettings(this.env);
  }

  providerConfig(selection?: ModelSelection, effort?: ReasoningEffort): ProviderConfig | null {
    return runtimeProviderConfig(this.providerSettingsData(), selection, effort);
  }

  providerSettings(): ProviderSettings {
    return publicProviderSettings(this.providerSettingsData());
  }

  providerSettingsResponse() {
    return json(this.providerSettings());
  }

  async saveProviderSettingsResponse(body: ReadableStream<Uint8Array>) {
    try {
      const input = await readJsonStream(body, MAX_BACKUP_BYTES, '供应商配置超过 12 MiB。');
      const result = this.saveProviderSettings(input as ProviderSettingsInput);
      return 'error' in result
        ? json({ error: result.error }, result.status ?? 400)
        : json(result.settings);
    } catch (error) {
      return json(
        { error: error instanceof HttpError ? error.message : '供应商配置暂时无法保存。' },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }

  sessionSettings() {
    const settings = this.providerSettings(),
      config = this.providerConfig();
    return {
      attachmentsConfigured: Boolean(this.env.ATTACHMENTS),
      provider: config?.provider ?? '',
      model: config?.model ?? '',
      modelName: config?.modelName ?? '',
      activeProviderId: config?.providerId ?? null,
      models: chatModels(settings),
      systemPrompt: settings.systemPrompt,
      maxOutputTokens: settings.maxOutputTokens,
    };
  }

  backupSettings(): BackupSettings {
    const settings = this.providerSettingsData();
    return {
      providers: settings.providers.map(({ id, name, provider, baseUrl, models }) => ({
        id,
        name,
        provider,
        baseUrl,
        models,
      })),
      activeProviderId: settings.activeProviderId,
      activeModel: settings.activeModel,
      systemPrompt: settings.systemPrompt,
      maxOutputTokens: settings.maxOutputTokens,
      promptPresets: this.presets.list(),
    };
  }

  providerForModelList(id: string): ProviderModelConfig | null {
    return this.providerSettingsData().providers.find((profile) => profile.id === id) ?? null;
  }

  saveProviderSettings(
    input: ProviderSettingsInput,
    importedPresets?: PromptPreset[],
    options: { restoreModelMetadata?: boolean; preserveKeysAcrossConnections?: boolean } = {},
  ): { settings: ProviderSettings } | { error: string; status?: number } {
    let settings: ProviderSettingsInput;
    let presets: PromptPreset[] = [];
    try {
      settings = mergeProviderSettings(this.providerSettingsData(), input, options);
      if (importedPresets) presets = this.presets.prepareRestore(importedPresets);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '供应商配置无效。',
        ...(error instanceof PromptPresetError ? { status: error.status } : {}),
      };
    }
    this.storage.transactionSync(() => {
      this.presets.insertRestored(presets);
      this.storage.sql.exec('DELETE FROM provider_profiles');
      for (const profile of settings.providers) {
        this.storage.sql.exec(
          'INSERT INTO provider_profiles (id, name, provider, baseUrl, models, apiKey) VALUES (?, ?, ?, ?, ?, ?)',
          profile.id,
          profile.name,
          profile.provider,
          profile.baseUrl,
          JSON.stringify(profile.models),
          profile.apiKey ?? null,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO provider_preferences (id, activeProviderId, activeModel, systemPrompt, maxOutputTokens)
        VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET activeProviderId = excluded.activeProviderId,
        activeModel = excluded.activeModel, systemPrompt = excluded.systemPrompt, maxOutputTokens = excluded.maxOutputTokens`,
        // Store an unset limit as 0 in SQLite; expose it as null through the API.
        settings.activeProviderId,
        settings.activeModel,
        settings.systemPrompt,
        settings.maxOutputTokens ?? 0,
      );
    });
    return { settings: publicProviderSettings(settings) };
  }
}
