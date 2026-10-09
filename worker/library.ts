import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ConversationInfo } from '../shared/types';

export class Library extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, startedAt INTEGER NOT NULL)`);
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
  // Count before password checking so concurrent failures cannot bypass the limit.
  allowLogin(ip: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM login_attempts WHERE startedAt < ?', now - 15 * 60_000);
    this.ctx.storage.sql.exec('INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1', ip, now);
    return this.ctx.storage.sql.exec<{ attempts: number }>('SELECT attempts FROM login_attempts WHERE ip = ?', ip).one().attempts <= 10;
  }
  clearLogin(ip: string) { this.ctx.storage.sql.exec('DELETE FROM login_attempts WHERE ip = ?', ip); }
}
