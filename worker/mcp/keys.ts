import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlQuery } from '../generation/metrics';
import type { McpKeyInfo } from '../../shared/mcp/types';

export const MCP_KEYS_SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, keyHint TEXT NOT NULL,
  createdAt INTEGER NOT NULL, lastUsedAt INTEGER, readSystemPrompts INTEGER NOT NULL DEFAULT 0
)`;
// A coarse usage timestamp is sufficient for the management list. Persist at most
// once per key per hour, rather than writing for every MCP status poll.
const LAST_USED_INTERVAL = 60 * 60 * 1000;
export interface McpPrincipal {
  keyId: string;
}
export class McpKeys {
  constructor(private readonly query: SqlQuery) {}
  list(): McpKeyInfo[] {
    return this.query<McpKeyInfo & Record<string, SqlStorageValue>>(
      'SELECT id,name,keyHint,createdAt,lastUsedAt,readSystemPrompts FROM mcp_keys ORDER BY createdAt DESC,id',
    )
      .toArray()
      .map((row) => ({ ...row, readSystemPrompts: Boolean(row.readSystemPrompts) }));
  }
  create(name: string, readSystemPrompts = false) {
    const id = crypto.randomUUID(),
      key = `ec_mcp_${id}_${randomBytes(32).toString('base64url')}`,
      createdAt = Date.now(),
      keyHint = `ec_mcp_••••${key.slice(-6)}`;
    this.query(
      'INSERT INTO mcp_keys (id,name,hash,keyHint,createdAt,readSystemPrompts) VALUES (?,?,?,?,?,?)',
      id,
      name,
      createHash('sha256').update(key).digest('hex'),
      keyHint,
      createdAt,
      Number(readSystemPrompts),
    );
    return { id, name, keyHint, createdAt, lastUsedAt: null, key, readSystemPrompts };
  }
  rename(id: string, name: string, readSystemPrompts?: boolean) {
    const row =
      this.query<McpKeyInfo & Record<string, SqlStorageValue>>(
        'UPDATE mcp_keys SET name=?,readSystemPrompts=COALESCE(?,readSystemPrompts) WHERE id=? RETURNING id,name,keyHint,createdAt,lastUsedAt,readSystemPrompts',
        name,
        readSystemPrompts === undefined ? null : Number(readSystemPrompts),
        id,
      ).toArray()[0] ?? null;
    return row ? { ...row, readSystemPrompts: Boolean(row.readSystemPrompts) } : null;
  }
  permissions(id: string) {
    const row = this.query<{ readSystemPrompts: number }>(
      'SELECT readSystemPrompts FROM mcp_keys WHERE id=?',
      id,
    ).toArray()[0];
    return row ? { readSystemPrompts: Boolean(row.readSystemPrompts) } : null;
  }
  revoke(id: string) {
    this.query('DELETE FROM mcp_keys WHERE id=?', id);
  }
  exists(id: string) {
    return this.query('SELECT 1 FROM mcp_keys WHERE id=?', id).toArray().length > 0;
  }
  authenticate(key: string): McpPrincipal | null {
    const match = /^ec_mcp_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(key);
    if (!match) return null;
    const row = this.query<{ hash: string; lastUsedAt: number | null }>(
      'SELECT hash,lastUsedAt FROM mcp_keys WHERE id=?',
      match[1],
    ).toArray()[0];
    const digest = createHash('sha256').update(key).digest();
    if (!row || !timingSafeEqual(Buffer.from(row.hash, 'hex'), digest)) return null;
    const now = Date.now();
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_INTERVAL)
      this.query('UPDATE mcp_keys SET lastUsedAt=? WHERE id=?', now, match[1]);
    return { keyId: match[1] };
  }
}
