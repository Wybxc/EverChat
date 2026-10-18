import { createHash } from 'node:crypto';
import type { SqlQuery } from '../generation/metrics';

export const requestFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// State versions survive restarts; notifications and their payloads do not.
export function initializeConversationState(sql: SqlStorage) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS conversation_state (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, epoch TEXT NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS message_versions (messageId TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  );
  if (sql.exec('SELECT id FROM conversation_state WHERE id = 1').toArray().length) return;
  const legacy = sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .toArray().length;
  const seq = legacy
    ? sql.exec<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').one().seq
    : 0;
  sql.exec('INSERT INTO conversation_state VALUES (1, ?, ?)', seq, crypto.randomUUID());
  sql.exec('INSERT INTO message_versions SELECT id, ? FROM messages', seq);
  for (const row of sql
    .exec<{ id: string; fingerprint: string }>('SELECT id, fingerprint FROM submissions')
    .toArray())
    if (row.fingerprint && !/^[a-f0-9]{64}$/.test(row.fingerprint))
      sql.exec(
        'UPDATE submissions SET fingerprint = ? WHERE id = ?',
        createHash('sha256').update(row.fingerprint).digest('hex'),
        row.id,
      );
  if (legacy) sql.exec('DROP TABLE events');
}

export class ConversationState {
  constructor(private readonly query: SqlQuery) {}
  current() {
    return this.query<{ seq: number; epoch: string }>(
      'SELECT seq, epoch FROM conversation_state WHERE id = 1',
    ).one();
  }
  advance(ids: string[]) {
    const { seq } = this.query<{ seq: number }>(
      'UPDATE conversation_state SET seq = seq + 1 WHERE id = 1 RETURNING seq',
    ).one();
    for (const id of ids)
      this.query(
        'INSERT INTO message_versions VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET version = excluded.version',
        id,
        seq,
      );
    return seq;
  }
}
