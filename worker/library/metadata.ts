export function initializeConversationMetadata(storage: DurableObjectStorage) {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS conversation_metadata (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL)',
  );
}
