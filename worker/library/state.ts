import type { LibraryWatermark } from '../../shared/library/protocol';
import type { SqlQuery } from '../generation/metrics';

export const LIBRARY_STATE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS library_state (id INTEGER PRIMARY KEY CHECK (id=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL)';

// Triggers keep the watermark atomic even for writes in the copy/import/title
// stores. Only fields that can change the index are watched, never token data.
const watched = {
  conversations: ['title', 'createdAt', 'updatedAt'],
  conversation_metadata: ['pinned'],
  conversation_titles: ['source', 'task'],
  conversation_activity: ['version', 'payload'],
  conversation_deletions: ['deletedAt'],
  conversation_copies: ['status'],
  archive_imports: ['status'],
};
export function libraryStateTriggers(tableExists: (table: string) => boolean = () => true) {
  return Object.entries(watched).flatMap(([table, columns]) =>
    tableExists(table)
      ? ['INSERT', 'UPDATE', 'DELETE'].map(
          (
            operation,
          ) => `CREATE TRIGGER IF NOT EXISTS library_revision_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table}
          ${operation === 'UPDATE' ? `WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : ''}
          BEGIN UPDATE library_state SET revision=revision+1 WHERE id=1; END`,
        )
      : [],
  );
}
export function initializeLibraryState(query: SqlQuery) {
  query(LIBRARY_STATE_SCHEMA);
  query('INSERT OR IGNORE INTO library_state VALUES (1, ?, 0)', crypto.randomUUID());
  for (const statement of libraryStateTriggers()) query(statement);
}
export class LibraryState {
  constructor(private readonly query: SqlQuery) {}
  current(): LibraryWatermark {
    const { epoch, revision } = this.query<LibraryWatermark & Record<string, SqlStorageValue>>(
      'SELECT epoch, revision FROM library_state WHERE id=1',
    ).one();
    return { epoch, revision };
  }
}
