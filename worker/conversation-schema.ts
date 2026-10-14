import { STREAM_JOURNAL_SCHEMA } from './stream-journal';
export const DELETION_SCHEMA = 'CREATE TABLE IF NOT EXISTS conversation_deletion (id INTEGER PRIMARY KEY CHECK (id = 1), deletedAt INTEGER NOT NULL)';

export function initializeConversation(sql: SqlStorage, metrics: boolean) {
  sql.exec(DELETION_SCHEMA);
  if (sql.exec('SELECT deletedAt FROM conversation_deletion WHERE id = 1').toArray().length) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    createdAt INTEGER NOT NULL, runId TEXT, parentId TEXT, revisionOf TEXT, error TEXT,
    reasoning TEXT, providerId TEXT, model TEXT, modelName TEXT, streamVersion TEXT,
    durableOffset INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS message_deletions (id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS conversation_settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, assistantId TEXT NOT NULL,
    context TEXT NOT NULL, chunkSeq INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
    config TEXT, streamVersion TEXT, durableOffset INTEGER NOT NULL DEFAULT 0,
    executor TEXT NOT NULL DEFAULT 'do-v1', startedAt INTEGER, cancelRequested INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
  sql.exec(STREAM_JOURNAL_SCHEMA);
  sql.exec('CREATE TABLE IF NOT EXISTS message_generations (messageId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS message_summaries (messageId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS message_images (messageId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS run_dependencies (runId TEXT PRIMARY KEY, summaryRunId TEXT NOT NULL, summaryId TEXT NOT NULL, payload TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS generation_timings (runId TEXT PRIMARY KEY, providerStartedAt INTEGER NOT NULL, firstTokenAt INTEGER)');
  sql.exec('CREATE TABLE IF NOT EXISTS message_search_versions (messageId TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_outbox (messageId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, version INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_retry (id INTEGER PRIMARY KEY CHECK (id = 1), attempts INTEGER NOT NULL, nextAt INTEGER NOT NULL)');
  if (metrics) sql.exec('CREATE TABLE IF NOT EXISTS generation_measurements (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
}
