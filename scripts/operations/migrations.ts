import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ProviderKind } from '../../shared/providers/types';
import type { UsageRecord, UsageTotals } from '../../shared/usage/types';
import { initializeConversation } from '../../worker/conversation/schema';
import { initializeConversationState } from '../../worker/conversation/state';
import type { SqlQuery } from '../../worker/generation/metrics';
import { STORAGE_SCHEMA, STORAGE_SCHEMA_VERSION } from '../../worker/platform/storage-schema';
import { GenerationCheckpoints } from '../../worker/streaming/checkpoints';
import { addRecord, emptyTotals } from '../../worker/usage/aggregate';
import { USAGE_OUTBOX_SCHEMA } from '../../worker/usage/schema';
import { MCP_REQUESTS_SCHEMA } from '../../worker/mcp/schema';
import { MCP_KEYS_SCHEMA } from '../../worker/mcp/keys';
import { encodeValue, type Statement, type StoreKind } from './storage-protocol';

// Only this Node.js operations module understands previous database formats.
// The returned patch contains values already converted locally, never a parser
// or a migration callback to execute while serving production traffic.
export function migrateStorage(db: DatabaseSync, kind: StoreKind): Statement[] {
  if (kind === 'usage') throw new Error('Usage cleanup requires cleanIncompleteUsage');
  const patch: Statement[] = [];
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const statement = db.prepare(sql);
    const rows = statement.all(...(args as SQLInputValue[])) as T[];
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) patch.push({ sql, args: args.map(encodeValue) });
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error('Expected one SQL row');
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  const exists = (table: string) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const columns = (table: string) =>
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map(({ name }) => name);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (exists('storage_schema')) {
      const version = db.prepare('SELECT version FROM storage_schema WHERE id=1').get()?.version;
      if (
        version !== undefined &&
        version !== 1 &&
        version !== 2 &&
        version !== STORAGE_SCHEMA_VERSION
      )
        throw new Error(`Unsupported storage schema version: ${version}`);
    }
    query(STORAGE_SCHEMA);
    query('DELETE FROM storage_schema');
    query(USAGE_OUTBOX_SCHEMA);
    if (kind === 'conversation' && exists('messages')) {
      const seq = exists('events')
        ? Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()!.seq)
        : 0;
      const hadState =
        exists('conversation_state') &&
        Boolean(db.prepare('SELECT 1 FROM conversation_state WHERE id=1').get());
      initializeConversationState({ exec: query } as unknown as SqlStorage);
      if (!hadState) {
        query('UPDATE conversation_state SET seq=? WHERE id=1', seq);
        query('INSERT OR REPLACE INTO message_versions SELECT id, ? FROM messages', seq);
      }
      for (const row of db.prepare('SELECT id, fingerprint FROM submissions').all())
        if (row.fingerprint && !/^[a-f0-9]{64}$/.test(String(row.fingerprint)))
          query(
            'UPDATE submissions SET fingerprint=? WHERE id=?',
            createHash('sha256').update(String(row.fingerprint)).digest('hex'),
            String(row.id),
          );
      // Temporarily mark the local database so current-schema creation can add
      // missing empty feature tables. The remote version marker is written last.
      db.prepare('INSERT INTO storage_schema VALUES (1, ?)').run(STORAGE_SCHEMA_VERSION);
      initializeConversation({ exec: query } as unknown as SqlStorage, false);
      const oldActive = db
        .prepare(
          "SELECT COUNT(*) AS count FROM runs JOIN messages ON messages.id=runs.assistantId WHERE messages.status IN ('queued','running') AND runs.streamVersion='raw-sse-v1'",
        )
        .get()!.count;
      assert.equal(oldActive, 0, '旧版流任务仍在进行，请在旧版本完成或停止后重新备份迁移。');
      if (exists('conversation_settings')) {
        for (const row of db.prepare('SELECT id,payload FROM conversation_settings').all()) {
          const value = JSON.parse(String(row.payload));
          if ('useSummaries' in value) {
            delete value.useSummaries;
            query(
              'UPDATE conversation_settings SET payload=? WHERE id=?',
              JSON.stringify(value),
              row.id as number,
            );
          }
        }
      }
      if (exists('tool_stream_commits')) query('DROP TABLE tool_stream_commits');
      if (exists('stream_commits')) {
        const checkpoints = new GenerationCheckpoints(query);
        for (const run of db
          .prepare(
            "SELECT runs.id, runs.assistantId, runs.config FROM runs JOIN messages ON messages.id=runs.assistantId WHERE messages.status IN ('queued','running')",
          )
          .all()) {
          const tools =
            exists('message_web_tools') &&
            Boolean(
              db
                .prepare('SELECT 1 FROM message_web_tools WHERE messageId=?')
                .get(run.assistantId as string),
            );
          const protocol: ProviderKind = tools
            ? 'openai-chat'
            : run.config
              ? JSON.parse(String(run.config)).provider
              : 'openai-chat';
          for (const row of db
            .prepare('SELECT payload FROM stream_commits WHERE runId=? ORDER BY chunkSeq')
            .all(run.id as string))
            checkpoints.append(
              {
                runId: String(run.id),
                messageId: String(run.assistantId),
                batches: JSON.parse(String(row.payload)),
              },
              { protocol },
            );
        }
        query('DROP TABLE stream_commits');
      }
      if (exists('events')) query('DROP TABLE events');
    } else if (kind === 'library') {
      query(MCP_REQUESTS_SCHEMA);
      query(MCP_KEYS_SCHEMA);
      if (
        exists('conversation_metadata') &&
        columns('conversation_metadata').includes('archived')
      ) {
        query(
          'CREATE TABLE conversation_metadata_clean (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL)',
        );
        query(
          'INSERT INTO conversation_metadata_clean SELECT id, pinned FROM conversation_metadata',
        );
        query('DROP TABLE conversation_metadata');
        query('ALTER TABLE conversation_metadata_clean RENAME TO conversation_metadata');
      }
      if (exists('conversation_copies'))
        for (const column of ['viewHeadId', 'copiedHeadId'])
          if (!columns('conversation_copies').includes(column))
            query(`ALTER TABLE conversation_copies ADD COLUMN ${column} TEXT`);
      if (exists('web_tool_service') && !columns('web_tool_service').includes('provider')) {
        query("ALTER TABLE web_tool_service ADD COLUMN provider TEXT NOT NULL DEFAULT 'tavily'");
        query(
          'CREATE TABLE IF NOT EXISTS web_tool_credentials (provider TEXT PRIMARY KEY, apiKey TEXT NOT NULL)',
        );
        query(
          "INSERT OR IGNORE INTO web_tool_credentials SELECT 'tavily', apiKey FROM web_tool_service WHERE id=1",
        );
        query("UPDATE web_tool_service SET apiKey=''");
      }
    }
    // The version gate stays closed throughout an interrupted remote import.
    db.prepare('DELETE FROM storage_schema').run();
    query('INSERT INTO storage_schema VALUES (1, ?)', STORAGE_SCHEMA_VERSION);
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed');
    db.exec('COMMIT');
    return patch;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Offline only: no historical repair or deletion is performed by the application.
export function cleanIncompleteUsage(db: DatabaseSync) {
  const statements: Statement[] = [];
  const counts = { before: 0, removed: 0, retained: 0, correctionsRemoved: 0 };
  const write = (sql: string, args: (string | number)[] = []) => {
    db.prepare(sql).run(...args);
    statements.push({ sql, args });
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(db.prepare('SELECT version FROM storage_schema WHERE id=1').get()?.version, 1);
    const groups = new Map<string, { record: UsageRecord; hour: number; totals: UsageTotals }>();
    for (const row of db.prepare('SELECT id,payload FROM usage_attempts ORDER BY id').all()) {
      const record = JSON.parse(String(row.payload)) as UsageRecord & { correction?: unknown };
      assert.equal(record.id, row.id, 'Usage identity mismatch');
      counts.before++;
      if (
        record.status !== 'running' &&
        (!record.usageIsFinal ||
          record.cost.state !== 'priced' ||
          !record.price ||
          record.cost.amount === null)
      ) {
        write('DELETE FROM usage_attempts WHERE id=?', [record.id]);
        counts.removed++;
        continue;
      }
      counts.retained++;
      if (record.correction !== undefined) {
        delete record.correction;
        write('UPDATE usage_attempts SET payload=? WHERE id=?', [
          JSON.stringify(record),
          record.id,
        ]);
        counts.correctionsRemoved++;
      }
      const hour = Math.floor(record.startedAt / 3_600_000) * 3_600_000;
      const key = JSON.stringify([
        hour,
        record.providerId,
        record.model,
        record.kind,
        record.status,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = { record, hour, totals: emptyTotals() };
        groups.set(key, group);
      }
      addRecord(group.totals, record);
    }
    write('DELETE FROM usage_rollups');
    for (const [key, { record, hour, totals }] of groups)
      write('INSERT INTO usage_rollups VALUES (?,?,?,?,?,?,?)', [
        key,
        hour,
        record.providerId,
        record.model,
        record.kind,
        record.status,
        JSON.stringify({ totals, providerName: record.providerName, modelName: record.modelName }),
      ]);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    db.exec('COMMIT');
    return { statements, counts };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
