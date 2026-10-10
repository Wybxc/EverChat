import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ConversationInfo, ProviderConfig, ProviderSettings } from '../shared/types';
import { mergeProviderConfig, providerConfigFromEnv, publicProviderSettings } from './provider-config';

export class Library extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, startedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL, baseUrl TEXT NOT NULL,
      model TEXT NOT NULL, systemPrompt TEXT NOT NULL, maxOutputTokens INTEGER NOT NULL, apiKey TEXT
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
  providerConfig(): ProviderConfig {
    const row = this.ctx.storage.sql.exec<ProviderConfig & Record<string, SqlStorageValue>>('SELECT provider, baseUrl, model, systemPrompt, maxOutputTokens, apiKey FROM provider_config WHERE id = 1').toArray()[0];
    if (!row) return providerConfigFromEnv(this.env);
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      model: row.model,
      systemPrompt: row.systemPrompt,
      maxOutputTokens: Number(row.maxOutputTokens),
      apiKey: typeof row.apiKey === 'string' && row.apiKey ? row.apiKey : undefined,
    };
  }
  saveProviderConfig(input: ProviderConfig): { settings: ProviderSettings } | { error: string } {
    let config: ProviderConfig;
    try { config = mergeProviderConfig(this.providerConfig(), input); }
    catch (error) { return { error: error instanceof Error ? error.message : '供应商配置无效。' }; }
    this.ctx.storage.sql.exec(`INSERT INTO provider_config (id, provider, baseUrl, model, systemPrompt, maxOutputTokens, apiKey)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, baseUrl = excluded.baseUrl,
      model = excluded.model, systemPrompt = excluded.systemPrompt, maxOutputTokens = excluded.maxOutputTokens,
      apiKey = excluded.apiKey`, config.provider, config.baseUrl, config.model, config.systemPrompt, config.maxOutputTokens, config.apiKey ?? null);
    return { settings: publicProviderSettings(config) };
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
