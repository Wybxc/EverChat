import { AppError, problem } from '../../shared/errors/descriptor';
import type { SqlQuery } from '../generation/metrics';

export const STORAGE_SCHEMA_VERSION = 5;
export const STORAGE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS storage_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)';

// Existing databases must be prepared by the offline operations tool. Starting
// an object may create an empty database, but must never convert persisted data.
export function initializeStorageSchema(query: SqlQuery, expectedVersion = STORAGE_SCHEMA_VERSION) {
  const tables = query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__cf_*' AND name != '__miniflare_do_name'",
  ).toArray();
  if (tables.length) {
    const version = tables.some(({ name }) => name === 'storage_schema')
      ? query<{ version: number }>('SELECT version FROM storage_schema WHERE id = 1').toArray()[0]
          ?.version
      : undefined;
    if (version !== expectedVersion)
      throw new AppError(problem('SCHEMA_MISMATCH'), '数据库版本不匹配，请先运行本地运维迁移。');
    return;
  }
  query(STORAGE_SCHEMA);
  query('INSERT INTO storage_schema VALUES (1, ?)', expectedVersion);
}
