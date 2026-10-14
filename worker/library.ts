import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ConversationInfo, ModelSelection, PromptPreset, PromptPresetInput, ProviderConfig, ProviderModelConfig, ProviderSettings, ProviderSettingsInput, ReasoningEffort } from '../shared/types';
import { defaultProviderSettings, mergeProviderSettings, publicProviderSettings, runtimeProviderConfig } from './provider-config';
import { MAX_CONVERSATIONS } from './resource-limits';
import { SearchIndex, SearchChanged, SEARCH_CAPACITY_MESSAGE, searchRetryDelay } from './search-index';
import type { SearchDocument } from '../shared/search';
import type { BackupSettings } from '../shared/backup';
import { PromptPresets, PromptPresetError } from './prompt-presets';

type Deletion = { id: string; deletedAt: number; completed: number } & Record<string, SqlStorageValue>;
const conversationSelect = `SELECT conversations.*, COALESCE(metadata.pinned, 0) AS pinned, COALESCE(metadata.archived, 0) AS archived
  FROM conversations LEFT JOIN conversation_metadata AS metadata ON metadata.id = conversations.id
  WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = conversations.id)`;
const decorate = (row: Record<string, SqlStorageValue>) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived) }) as unknown as ConversationInfo;

export class Library extends DurableObject<Env> {
  private readonly searchIndex: SearchIndex;
  private readonly presets: PromptPresets;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.presets = new PromptPresets(ctx.storage);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS conversation_metadata (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS conversation_deletions (id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, startedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, baseUrl TEXT NOT NULL,
      models TEXT NOT NULL, apiKey TEXT
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS provider_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1), activeProviderId TEXT, activeModel TEXT NOT NULL,
      systemPrompt TEXT NOT NULL, maxOutputTokens INTEGER NOT NULL, showReasoning INTEGER NOT NULL DEFAULT 0
    )`);
    this.searchIndex = new SearchIndex(ctx.storage);
    // Feature initialization reads existing messages in bounded pages, never on a search request.
    ctx.storage.sql.exec(`INSERT OR IGNORE INTO search_backfill(conversationId) SELECT id FROM conversations
      WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = conversations.id)`);
    ctx.waitUntil(this.scheduleMaintenance());
  }
  private async scheduleMaintenance() {
    await this.ctx.storage.transaction(async () => {
      const sql = this.ctx.storage.sql;
      const pending = sql.exec<{ nextAt: number }>('SELECT MIN(nextAt) AS nextAt FROM search_backfill WHERE done = 0 HAVING COUNT(*) > 0').toArray()[0];
      if (!pending) return;
      const alarm = await this.ctx.storage.getAlarm();
      const next = Math.max(Date.now() + 1000, pending.nextAt);
      if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
    });
  }
  applySearchDocuments(id: string, documents: SearchDocument[]) {
    if (!this.get(id)) return;
    try {
      this.searchIndex.replace(id, documents);
      this.ctx.storage.sql.exec('DELETE FROM search_problems WHERE conversationId = ?', id);
    } catch (error) {
      this.ctx.storage.sql.exec('INSERT INTO search_problems VALUES (?, ?) ON CONFLICT(conversationId) DO UPDATE SET error = excluded.error', id,
        error instanceof Error && error.message === SEARCH_CAPACITY_MESSAGE ? SEARCH_CAPACITY_MESSAGE : '部分对话的索引尚未更新，请稍后重试。');
      throw error;
    }
  }
  search(query: string, archived: boolean, cursor?: string) {
    try { return this.searchIndex.search(query, archived, cursor); }
    catch (error) { if (error instanceof SearchChanged) return { error: error.message, status: 409 }; throw error; }
  }
  list(): ConversationInfo[] {
    return this.ctx.storage.sql.exec(`${conversationSelect} ORDER BY pinned DESC, updatedAt DESC, conversations.id`).toArray().map(decorate);
  }
  indexSnapshot(after: number) {
    const rows = this.ctx.storage.sql.exec<{ seq: number; id: string; deletedAt: number }>('SELECT rowid AS seq, id, deletedAt FROM conversation_deletions WHERE rowid > ? ORDER BY rowid LIMIT 257', after).toArray();
    const page = rows.slice(0, 256);
    return { conversations: this.list(), deletions: page.map(({ id, deletedAt }) => ({ id, deletedAt })),
      deletionCursor: page.at(-1)?.seq ?? after, hasMoreDeletions: rows.length > 256 };
  }
  get(id: string): ConversationInfo | null {
    const row = this.ctx.storage.sql.exec(`${conversationSelect} AND conversations.id = ?`, id).toArray()[0];
    return row ? decorate(row) : null;
  }
  deletedAt(id: string): number | null {
    return this.ctx.storage.sql.exec<Deletion>('SELECT * FROM conversation_deletions WHERE id = ?', id).toArray()[0]?.deletedAt ?? null;
  }
  create(id: string, title: string) {
    if (this.deletedAt(id)) return { error: '这个对话已删除。', status: 410 };
    const existing = this.get(id);
    if (existing) return existing;
    if (this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations').one().count >= MAX_CONVERSATIONS) {
      return { error: `空间最多保存 ${MAX_CONVERSATIONS} 个对话，请整理已有对话后再创建。`, status: 507 };
    }
    const now = Date.now();
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO conversations VALUES (?, ?, ?, ?)', id, title, now, now);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO search_backfill(conversationId) VALUES (?)', id);
    this.ctx.waitUntil(this.scheduleMaintenance());
    return this.get(id)!;
  }
  touch(id: string) { if (!this.deletedAt(id)) this.ctx.storage.sql.exec('UPDATE conversations SET updatedAt = ? WHERE id = ?', Date.now(), id); }
  update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    if (this.deletedAt(id)) return { error: '这个对话已删除。', status: 410 };
    const current = this.get(id);
    if (!current) return { error: '找不到这个对话。', status: 404 };
    this.ctx.storage.transactionSync(() => {
      if (patch.title !== undefined) this.ctx.storage.sql.exec('UPDATE conversations SET title = ? WHERE id = ?', patch.title, id);
      if (patch.pinned !== undefined || patch.archived !== undefined) {
        this.ctx.storage.sql.exec(`INSERT INTO conversation_metadata VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pinned = excluded.pinned, archived = excluded.archived`,
          id, Number(patch.pinned ?? current.pinned), Number(patch.archived ?? current.archived));
      }
      this.searchIndex.changed();
    });
    return this.get(id)!;
  }
  async beginDelete(id: string) {
    return this.ctx.storage.transaction(async () => {
      const existing = this.ctx.storage.sql.exec<Deletion>('SELECT * FROM conversation_deletions WHERE id = ?', id).toArray()[0];
      if (existing?.completed) return existing;
      const deletion = existing ?? { id, deletedAt: Date.now(), completed: 0 };
      if (!existing) this.ctx.storage.sql.exec('INSERT INTO conversation_deletions VALUES (?, ?, 0)', id, deletion.deletedAt);
      this.searchIndex.remove(id);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return deletion;
    });
  }
  completeDelete(id: string) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM conversations WHERE id = ?', id);
      this.ctx.storage.sql.exec('DELETE FROM conversation_metadata WHERE id = ?', id);
      this.ctx.storage.sql.exec('UPDATE conversation_deletions SET completed = 1 WHERE id = ?', id);
    });
  }
  async alarm() {
    const pending = this.ctx.storage.sql.exec<Deletion>('SELECT * FROM conversation_deletions WHERE completed = 0 LIMIT 16').toArray();
    let failed = false;
    for (const deletion of pending) {
      try {
        await this.env.CONVERSATIONS.getByName(deletion.id).deleteConversation(deletion.deletedAt);
        this.completeDelete(deletion.id);
      } catch { failed = true; console.warn('EverChat deletion cleanup will retry'); }
    }
    const job = this.ctx.storage.sql.exec<{ conversationId: string; after: number; attempts: number }>('SELECT conversationId, after, attempts FROM search_backfill WHERE done = 0 AND nextAt <= ? ORDER BY nextAt, conversationId LIMIT 1', Date.now()).toArray()[0];
    if (job) {
      try {
        const page = await this.env.CONVERSATIONS.getByName(job.conversationId).searchDocumentPage(job.after);
        // Deletion may interleave while reading another object.
        if (this.get(job.conversationId)) {
          this.applySearchDocuments(job.conversationId, page.documents);
          this.ctx.storage.sql.exec('UPDATE search_backfill SET after = ?, done = ?, attempts = 0, nextAt = 0 WHERE conversationId = ?', page.after, Number(page.done), job.conversationId);
        }
      } catch {
        this.ctx.storage.sql.exec('UPDATE search_backfill SET attempts = attempts + 1, nextAt = ? WHERE conversationId = ?', Date.now() + searchRetryDelay(job.attempts + 1), job.conversationId);
        console.warn('EverChat search initialization will retry');
      }
    }
    await this.ctx.storage.transaction(async () => {
      const deletion = this.ctx.storage.sql.exec('SELECT id FROM conversation_deletions WHERE completed = 0 LIMIT 1').toArray().length;
      const indexing = this.ctx.storage.sql.exec<{ nextAt: number }>('SELECT MIN(nextAt) AS nextAt FROM search_backfill WHERE done = 0 HAVING COUNT(*) > 0').toArray()[0];
      const next = Math.min(deletion ? Date.now() + (failed ? 30_000 : 1000) : Infinity, indexing ? Math.max(Date.now() + 1000, indexing.nextAt) : Infinity);
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next); else await this.ctx.storage.deleteAlarm();
    });
  }
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
  promptPresets() { return this.presets.list(); }
  savePromptPreset(id: string, input: PromptPresetInput) {
    try { return this.presets.save(id, input); }
    catch (error) { if (error instanceof PromptPresetError) return { error: error.message, status: error.status }; throw error; }
  }
  deletePromptPreset(id: string) { return this.presets.remove(id); }
  backupSettings(): BackupSettings {
    const settings = this.providerSettingsData();
    return {
      providers: settings.providers.map(({ id, name, provider, baseUrl, models }) => ({ id, name, provider, baseUrl, models })),
      activeProviderId: settings.activeProviderId, activeModel: settings.activeModel,
      systemPrompt: settings.systemPrompt, maxOutputTokens: settings.maxOutputTokens, showReasoning: settings.showReasoning,
      promptPresets: this.presets.list(),
    };
  }
  providerForModelList(id: string): ProviderModelConfig | null {
    return this.providerSettingsData().providers.find((profile) => profile.id === id) ?? null;
  }
  saveProviderSettings(input: ProviderSettingsInput, importedPresets?: PromptPreset[]): { settings: ProviderSettings } | { error: string; status?: number } {
    let settings: ProviderSettingsInput;
    let presets: PromptPreset[] = [];
    try {
      settings = mergeProviderSettings(this.providerSettingsData(), input);
      if (importedPresets) presets = this.presets.prepareRestore(importedPresets);
    }
    catch (error) { return { error: error instanceof Error ? error.message : '供应商配置无效。', ...(error instanceof PromptPresetError ? { status: error.status } : {}) }; }
    this.ctx.storage.transactionSync(() => {
      this.presets.insertRestored(presets);
      this.ctx.storage.sql.exec('DELETE FROM provider_profiles');
      for (const profile of settings.providers) {
        this.ctx.storage.sql.exec('INSERT INTO provider_profiles (id, name, provider, baseUrl, models, apiKey) VALUES (?, ?, ?, ?, ?, ?)',
          profile.id, profile.name, profile.provider, profile.baseUrl, JSON.stringify(profile.models), profile.apiKey ?? null);
      }
      this.ctx.storage.sql.exec(`INSERT INTO provider_preferences (id, activeProviderId, activeModel, systemPrompt, maxOutputTokens, showReasoning)
        VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET activeProviderId = excluded.activeProviderId,
        activeModel = excluded.activeModel, systemPrompt = excluded.systemPrompt, maxOutputTokens = excluded.maxOutputTokens, showReasoning = excluded.showReasoning`,
      // Store an unset limit as 0 in SQLite; expose it as null through the API.
      settings.activeProviderId, settings.activeModel, settings.systemPrompt, settings.maxOutputTokens ?? 0, Number(settings.showReasoning));
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
