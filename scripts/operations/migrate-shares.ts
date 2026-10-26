import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SqlQuery } from '../../worker/generation/metrics';
import { SHARING_SCHEMA, SHARING_SCHEMA_VERSION } from '../../worker/sharing/schema';
import { ShareRepository, type ShareRow } from '../../worker/sharing/store';
import { renderShareMessages } from '../../worker/sharing/render';
import { STORAGE_SCHEMA } from '../../worker/platform/storage-schema';
import { encodeValue, type Statement } from './storage-protocol';

/** Run only on an operator's local SQLite copy; the remote patch is plain SQL. */
export function migrateShares(db: DatabaseSync, now = Date.now()): Statement[] {
  const patch: Statement[] = [];
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as SQLInputValue[])) as T[];
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) patch.push({ sql, args: args.map(encodeValue) });
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error('Expected one row');
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = (name: string) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const version = exists('storage_schema')
      ? db.prepare('SELECT version FROM storage_schema WHERE id=1').get()?.version
      : undefined;
    if (version !== undefined && version !== 1 && version !== SHARING_SCHEMA_VERSION)
      throw new Error('Unsupported sharing schema');
    db.exec(STORAGE_SCHEMA);
    patch.push({ sql: STORAGE_SCHEMA, args: [] });
    query('DELETE FROM storage_schema');
    if (exists('shares')) {
      const columns = db
        .prepare('PRAGMA table_info(shares)')
        .all()
        .map((row) => row.name);
      for (const name of ['tokenHash', 'tokenCipher'])
        if (columns.includes(name)) query(`ALTER TABLE shares DROP COLUMN ${name}`);
      if (!columns.includes('htmlCount'))
        query('ALTER TABLE shares ADD COLUMN htmlCount INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(SHARING_SCHEMA);
    patch.push({ sql: SHARING_SCHEMA, args: [] });
    const repository = new ShareRepository(query, () => now);
    for (const row of query<ShareRow>(
      "SELECT * FROM shares WHERE status='active' AND (expiresAt IS NULL OR expiresAt>?)",
      now,
    )) {
      const digest = createHash('sha256');
      for (const payload of repository.payloads(row)) digest.update(payload + '\n');
      if (digest.digest('hex') !== row.hash) throw new Error('Share snapshot hash mismatch');
      repository.saveHtml(row.id, renderShareMessages(repository.payloads(row)));
    }
    query('INSERT INTO storage_schema VALUES (1, ?)', SHARING_SCHEMA_VERSION);
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
      throw new Error('Sharing integrity check failed');
    db.exec('COMMIT');
    return patch;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
