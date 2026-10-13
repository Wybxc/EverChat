import { STREAM_JOURNAL_SCHEMA } from './stream-journal';

export function initializeConversation(sql: SqlStorage, metrics: boolean) {
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    createdAt INTEGER NOT NULL, runId TEXT, parentId TEXT, revisionOf TEXT, error TEXT
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, assistantId TEXT NOT NULL,
    context TEXT NOT NULL, chunkSeq INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(messages)').toArray().map((row) => row.name));
  for (const [name, type] of [['reasoning', 'TEXT'], ['providerId', 'TEXT'], ['model', 'TEXT'], ['modelName', 'TEXT'],
    ['streamVersion', 'TEXT'], ['durableOffset', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }
  const runColumns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(runs)').toArray().map((row) => row.name));
  for (const [name, type] of [['config', 'TEXT'], ['streamVersion', 'TEXT'], ['durableOffset', 'INTEGER NOT NULL DEFAULT 0'],
    ['contentLength', 'INTEGER NOT NULL DEFAULT 0'], ['reasoningLength', 'INTEGER NOT NULL DEFAULT 0'],
    ['executor', "TEXT NOT NULL DEFAULT 'workflow-v1'"], ['startedAt', 'INTEGER'], ['cancelRequested', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!runColumns.has(name)) sql.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
  sql.exec(STREAM_JOURNAL_SCHEMA);
  if (metrics) sql.exec('CREATE TABLE IF NOT EXISTS generation_measurements (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
}
