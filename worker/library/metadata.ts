/** Retire archive state without touching conversations, timestamps or pinned state. */
export function initializeConversationMetadata(storage: DurableObjectStorage) {
  const sql = storage.sql;
  sql.exec(
    'CREATE TABLE IF NOT EXISTS conversation_metadata (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL)',
  );
  if (
    !sql
      .exec<{ name: string }>('PRAGMA table_info(conversation_metadata)')
      .toArray()
      .some((column) => column.name === 'archived')
  )
    return;
  storage.transactionSync(() => {
    sql.exec(
      'CREATE TABLE conversation_metadata_clean (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL)',
    );
    sql.exec(
      'INSERT INTO conversation_metadata_clean (id, pinned) SELECT id, pinned FROM conversation_metadata',
    );
    sql.exec('DROP TABLE conversation_metadata');
    sql.exec('ALTER TABLE conversation_metadata_clean RENAME TO conversation_metadata');
  });
}
