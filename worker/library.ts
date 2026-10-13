import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ConversationInfo, ModelSelection, ProviderConfig, ProviderModelConfig, ProviderSettings, ProviderSettingsInput, ReasoningEffort } from '../shared/types';
import { defaultProviderSettings, mergeProviderSettings, publicProviderSettings, runtimeProviderConfig } from './provider-config';

export class Library extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, startedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, baseUrl TEXT NOT NULL,
      models TEXT NOT NULL, apiKey TEXT
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1), activeProviderId TEXT, activeModel TEXT NOT NULL,
      systemPrompt TEXT NOT NULL, maxOutputTokens INTEGER NOT NULL, showReasoning INTEGER NOT NULL DEFAULT 0
    )`);

  }
  list(): ConversationInfo[] {
    return this.ctx.storage.sql.exec<ConversationInfo & Record<string, SqlStorageValue>>('SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT 500').toArray();
  }
  get(id: string): ConversationInfo | null {
    return this.ctx.storage.sql.exec<ConversationInfo & Record<string, SqlStorageValue>>('SELECT * FROM conversations WHERE id = ?', id).toArray()[0] ?? null;
  }
  create(id: string, title: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO conversations VALUES (?, ?, ?, ?)', id, title, now, now);
    return this.get(id)!;
  }
  touch(id: string) { this.ctx.storage.sql.exec('UPDATE conversations SET updatedAt = ? WHERE id = ?', Date.now(), id); }
  rename(id: string, title: string) { this.ctx.storage.sql.exec('UPDATE conversations SET title = ? WHERE id = ?', title, id); }
  private providerSettingsData(): ProviderSettingsInput {
    const preferences = this.ctx.storage.sql.exec<{
      activeProviderId: string | null; activeModel: string; systemPrompt: string; maxOutputTokens: number; showReasoning: number;
    } & Record<string, SqlStorageValue>>('SELECT activeProviderId, activeModel, systemPrompt, maxOutputTokens, showReasoning FROM provider_preferences WHERE id = 1').toArray()[0];
    const profiles = this.ctx.storage.sql.exec<{
      id: string; name: string; provider: ProviderModelConfig['provider']; baseUrl: string; models: string; apiKey: string | null;
    } & Record<string, SqlStorageValue>>('SELECT id, name, provider, baseUrl, models, apiKey FROM provider_profiles ORDER BY rowid').toArray();
    if (preferences || profiles.length) {
      const defaults = defaultProviderSettings(this.env);
      return {
        providers: profiles.map((profile) => ({
          id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl,
          models: JSON.parse(profile.models), ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        })),
        activeProviderId: preferences?.activeProviderId ?? null,
        activeModel: preferences?.activeModel ?? '',
        systemPrompt: preferences?.systemPrompt ?? defaults.systemPrompt,
        maxOutputTokens: Number(preferences?.maxOutputTokens ?? defaults.maxOutputTokens) || null,
        showReasoning: Boolean(preferences?.showReasoning ?? defaults.showReasoning),
      };
    }
    return defaultProviderSettings(this.env);
  }
  providerConfig(selection?: ModelSelection, effort?: ReasoningEffort): ProviderConfig | null {
    return runtimeProviderConfig(this.providerSettingsData(), selection, effort);
  }
  providerSettings(): ProviderSettings { return publicProviderSettings(this.providerSettingsData()); }
  providerForModelList(id: string): ProviderModelConfig | null {
    return this.providerSettingsData().providers.find((profile) => profile.id === id) ?? null;
  }
  saveProviderSettings(input: ProviderSettingsInput): { settings: ProviderSettings } | { error: string } {
    let settings: ProviderSettingsInput;
    try { settings = mergeProviderSettings(this.providerSettingsData(), input); }
    catch (error) { return { error: error instanceof Error ? error.message : '供应商配置无效。' }; }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM provider_profiles');
      for (const profile of settings.providers) {
        this.ctx.storage.sql.exec('INSERT INTO provider_profiles (id, name, provider, baseUrl, models, apiKey) VALUES (?, ?, ?, ?, ?, ?)',
          profile.id, profile.name, profile.provider, profile.baseUrl, JSON.stringify(profile.models), profile.apiKey ?? null);
      }
      this.ctx.storage.sql.exec(`INSERT INTO provider_preferences (id, activeProviderId, activeModel, systemPrompt, maxOutputTokens, showReasoning)
        VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET activeProviderId = excluded.activeProviderId,
        activeModel = excluded.activeModel, systemPrompt = excluded.systemPrompt, maxOutputTokens = excluded.maxOutputTokens, showReasoning = excluded.showReasoning`,
      // Store an unset limit as 0 in SQLite; expose it as null through the API.
      settings.activeProviderId, settings.activeModel, settings.systemPrompt, settings.maxOutputTokens ?? 0, settings.showReasoning);
    });
    return { settings: publicProviderSettings(settings) };
  }
  // Count before password checking so concurrent failures cannot bypass the limit.
  allowLogin(ip: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM login_attempts WHERE startedAt < ?', now - 15 * 60_000);
    this.ctx.storage.sql.exec('INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1', ip, now);
    return this.ctx.storage.sql.exec<{ attempts: number }>('SELECT attempts FROM login_attempts WHERE ip = ?', ip).one().attempts <= 10;
  }
  clearLogin(ip: string) { this.ctx.storage.sql.exec('DELETE FROM login_attempts WHERE ip = ?', ip); }
}
