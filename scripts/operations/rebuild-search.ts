import { ConversationMessages } from '../../worker/conversation/messages';
import { messageText } from '../../shared/conversation/content';
import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SearchDocument } from '../../shared/search/query';
import type { SqlQuery } from '../../worker/generation/metrics';
import { SearchIndex } from '../../worker/search/index';
import { GenerationCheckpoints } from '../../worker/streaming/checkpoints';
import { encodeValue, type Statement } from './storage-protocol';

const exists = (db: DatabaseSync, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function query(db: DatabaseSync, patch?: Statement[]): SqlQuery {
  return <T extends Record<string, SqlStorageValue>>(sql: string, ...args: SqlStorageValue[]) => {
    const rows = db.prepare(sql).all(...(args as SQLInputValue[])) as T[];
    if (patch && !/^\s*(SELECT|PRAGMA)\b/i.test(sql))
      patch.push({ sql, args: args.map(encodeValue) });
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
}

/** Read only canonical, finished, visible messages from a local conversation copy. */
export function* searchDocuments(db: DatabaseSync): Generator<SearchDocument> {
  if (
    exists(db, 'conversation_deletion') &&
    db.prepare('SELECT 1 FROM conversation_deletion').get()
  )
    return;
  if (!exists(db, 'messages')) return;
  const chunks = new GenerationCheckpoints(query(db));
  const messages = new ConversationMessages(
    query(db),
    chunks,
    () => null,
    () => {},
  );
  for (const row of db
    .prepare(
      `SELECT messages.*, COALESCE(message_search_versions.version, 0) AS version
    FROM messages LEFT JOIN message_search_versions ON message_search_versions.messageId=messages.id
    WHERE status NOT IN ('queued','running')
    AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE messageId=messages.id)
    AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=messages.id) ORDER BY messages.rowid`,
    )
    .iterate()) {
    assert.ok(row.role === 'user' || row.role === 'assistant');
    const message = messages.message(String(row.id));
    yield {
      messageId: String(row.id),
      version: Number(row.version),
      role: row.role,
      content: messageText(message),
      reasoning: messageText(message, 'reasoning'),
    };
  }
}

/** Runs only in Node against offline snapshots; the returned patch contains prepared index rows. */
export function rebuildSearch(
  db: DatabaseSync,
  conversations: Iterable<{ id: string; db: DatabaseSync }>,
): Statement[] {
  const patch: Statement[] = [];
  const exec = query(db, patch);
  const visible = new Set(
    db
      .prepare(
        `SELECT id FROM conversations
    WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE id=conversations.id)
    AND NOT EXISTS (SELECT 1 FROM conversation_copies WHERE id=conversations.id AND status!='completed')
    AND NOT EXISTS (SELECT 1 FROM archive_imports WHERE id=conversations.id AND status!='completed')`,
      )
      .all()
      .map(({ id }) => String(id)),
  );
  const seen = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    exec('DROP TABLE IF EXISTS search_fts');
    exec('DROP TABLE IF EXISTS search_fields');
    const index = new SearchIndex({
      sql: {
        exec,
        get databaseSize() {
          return (
            Number(db.prepare('PRAGMA page_count').get()!.page_count) *
            Number(db.prepare('PRAGMA page_size').get()!.page_size)
          );
        },
      },
      transactionSync<T>(operation: () => T) {
        return operation();
      },
    } as unknown as DurableObjectStorage);
    for (const table of ['search_fields', 'search_messages', 'search_backfill', 'search_problems'])
      exec(`DELETE FROM ${table}`);
    index.changed();
    for (const source of conversations) {
      if (!visible.has(source.id)) continue;
      assert.ok(!seen.has(source.id), 'Duplicate conversation in offline search sources');
      seen.add(source.id);
      for (const document of searchDocuments(source.db)) index.replace(source.id, [document]);
    }
    assert.deepEqual(
      seen,
      visible,
      'Missing canonical conversation snapshots; refuse partial reindex',
    );
    exec("INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)");
    db.exec('COMMIT');
    return patch;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
