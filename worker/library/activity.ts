import * as v from 'valibot';
import {
  conversationActivitySchema,
  type ActivityIndex,
  type ConversationActivity,
} from '../../shared/conversation/activity';
import type { SqlQuery } from '../generation/metrics';

export const LIBRARY_ACTIVITY_SCHEMA =
  'CREATE TABLE IF NOT EXISTS conversation_activity (id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL)';
export class LibraryActivityIndex {
  constructor(private readonly query: SqlQuery) {}
  accept(id: string, activity: ConversationActivity) {
    const value = v.parse(conversationActivitySchema, activity);
    this.query(
      `INSERT INTO conversation_activity SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE id = ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload = excluded.payload
      WHERE excluded.version > conversation_activity.version`,
      id,
      value.version,
      JSON.stringify(value),
      id,
      id,
    );
  }
  snapshot(): ActivityIndex {
    return Object.fromEntries(
      this.query<{ id: string; payload: string }>(
        `SELECT activity.id, activity.payload FROM conversation_activity AS activity
      JOIN conversations ON conversations.id = activity.id
      WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE id = activity.id)`,
      )
        .toArray()
        .map((row) => [row.id, JSON.parse(row.payload) as ConversationActivity]),
    );
  }
}
