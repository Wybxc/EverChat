import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MIGRATION_TABLES,
  decodeValue,
  encodeValue,
  quoteIdentifier,
  type StorageSnapshot,
  type StoreKind,
  type TableSchema,
  type IndexSchema,
  type Statement,
} from './storage-protocol';

// FTS is derived from search_fields. Never copy FTS shadow tables or export its
// external-content view as a second canonical copy of the same text.
export function snapshotStatements(snapshot: StorageSnapshot): Statement[] {
  const statements: Statement[] = [];
  for (const table of snapshot.schema) {
    statements.push({ sql: table.sql, args: [] });
    for (const row of snapshot.rows[table.name]) {
      const keys = Object.keys(row);
      statements.push({
        sql: `INSERT INTO ${quoteIdentifier(table.name)} (${keys.map(quoteIdentifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        args: Object.values(row),
      });
    }
  }
  if (snapshot.schema.some(({ name }) => name === 'search_fts'))
    for (const row of snapshot.rows.search_fields ?? [])
      statements.push({
        sql: 'INSERT INTO search_fts(rowid, normalized) VALUES (?, ?)',
        args: [row.id, row.normalized],
      });
  for (const index of snapshot.indexes) statements.push({ sql: index.sql, args: [] });
  return statements;
}

export function restoreSnapshot(db: DatabaseSync, snapshot: StorageSnapshot) {
  for (const statement of snapshotStatements(snapshot))
    db.prepare(statement.sql).run(...(statement.args.map(decodeValue) as SQLInputValue[]));
}

export function localSnapshot(db: DatabaseSync, kind: StoreKind): StorageSnapshot {
  const schema = (
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as unknown as TableSchema[]
  ).filter(({ name }) => MIGRATION_TABLES[kind].includes(name));
  const rows: StorageSnapshot['rows'] = {};
  const indexes = (
    db
      .prepare(
        "SELECT name, sql, tbl_name AS 'table' FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
      )
      .all() as unknown as IndexSchema[]
  ).filter((row) => MIGRATION_TABLES[kind].includes(row.table));
  for (const table of schema) {
    if (table.name === 'search_fts') {
      rows[table.name] = [];
      continue;
    }
    const keys = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
      .all()
      .filter(({ pk }) => pk)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map(({ name }) => quoteIdentifier(String(name)));
    rows[table.name] = db
      .prepare(
        `SELECT * FROM ${quoteIdentifier(table.name)}${keys.length ? ` ORDER BY ${keys.join(',')}` : ''}`,
      )
      .all()
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)])),
      );
  }
  return { schema, indexes, rows };
}
