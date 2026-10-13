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
  sql.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, assistantId TEXT NOT NULL,
    context TEXT NOT NULL, chunkSeq INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
    config TEXT, streamVersion TEXT, durableOffset INTEGER NOT NULL DEFAULT 0,
    executor TEXT NOT NULL DEFAULT 'do-v1', startedAt INTEGER, cancelRequested INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
  sql.exec(STREAM_JOURNAL_SCHEMA);
  sql.exec('CREATE TABLE IF NOT EXISTS generation_results (runId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  if (metrics) sql.exec('CREATE TABLE IF NOT EXISTS generation_measurements (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
}
