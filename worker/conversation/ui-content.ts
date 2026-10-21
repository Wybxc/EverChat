import type { EverChatUIPart } from '../../shared/conversation/ui-message';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import { payloadBytes } from '../../shared/streaming/batches';
import type { SqlQuery } from '../generation/metrics';

export const UI_CONTENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS message_parts (
    messageId TEXT NOT NULL, partIndex INTEGER NOT NULL, payload TEXT NOT NULL,
    textLength INTEGER NOT NULL, PRIMARY KEY(messageId, partIndex)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS message_text_chunks (
    messageId TEXT NOT NULL, partIndex INTEGER NOT NULL, ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(messageId, partIndex, ordinal)
  ) WITHOUT ROWID`,
] as const;
const CHUNK_CHARACTERS = 4096;
const textPart = (
  part: EverChatUIPart,
): part is Extract<EverChatUIPart, { type: 'text' | 'reasoning' }> =>
  part.type === 'text' || part.type === 'reasoning';
const descriptor = (part: EverChatUIPart) => {
  if (!textPart(part)) return { payload: JSON.stringify(part), textLength: 0 };
  const { text, ...fields } = part;
  return { payload: JSON.stringify(fields), textLength: text.length };
};
type PartRow = {
  partIndex: number;
  payload: string;
  textLength: number;
} & Record<string, SqlStorageValue>;

/** One ordered semantic representation. Text rows never contain a second full copy. */
export class UIContent {
  constructor(private readonly query: SqlQuery) {}

  read(messageId: string): EverChatUIPart[] {
    const rows = this.query<PartRow>(
      'SELECT partIndex,payload,textLength FROM message_parts WHERE messageId=? ORDER BY partIndex',
      messageId,
    ).toArray();
    const text = new Map<number, string[]>();
    for (const row of this.query<{
      partIndex: number;
      ordinal: number;
      payload: string;
    }>(
      'SELECT partIndex,ordinal,payload FROM message_text_chunks WHERE messageId=? ORDER BY partIndex,ordinal',
      messageId,
    )) {
      const chunks = text.get(row.partIndex) ?? [];
      if (row.ordinal !== chunks.length) throw new Error('Message text chunk gap');
      const value: unknown = JSON.parse(row.payload);
      if (typeof value !== 'string') throw new Error('Invalid message text chunk');
      chunks.push(value);
      text.set(row.partIndex, chunks);
    }
    const parts = rows.map((row, index) => {
      if (row.partIndex !== index) throw new Error('Message part gap');
      const part = JSON.parse(row.payload) as EverChatUIPart;
      if (textPart(part)) {
        if ('text' in (part as object)) throw new Error('Duplicate message text representation');
        const value = (text.get(index) ?? []).join('');
        if (value.length !== row.textLength) throw new Error('Message text length mismatch');
        text.delete(index);
        return { ...part, text: value };
      }
      if (row.textLength || text.has(index)) throw new Error('Unexpected message text chunks');
      return part;
    });
    if (text.size) throw new Error('Orphan message text chunks');
    return parts;
  }

  /**
   * The caller supplies the last durable parts and runs this synchronously in
   * its transaction. SDK preparation/validation takes place before that call.
   */
  write(messageId: string, before: readonly EverChatUIPart[], after: readonly EverChatUIPart[]) {
    for (let index = 0; index < after.length; index++) {
      const part = after[index],
        prior = before[index];
      const row = descriptor(part),
        previous = prior ? descriptor(prior) : undefined;
      if (payloadBytes(row.payload) > MAX_SQL_PAYLOAD_BYTES - 4096)
        throw new Error('Message part exceeds SQLite row capacity');
      if (row.payload !== previous?.payload || row.textLength !== previous.textLength)
        this.query(
          'INSERT INTO message_parts VALUES (?,?,?,?) ON CONFLICT(messageId,partIndex) DO UPDATE SET payload=excluded.payload,textLength=excluded.textLength',
          messageId,
          index,
          row.payload,
          row.textLength,
        );
      if (textPart(part)) {
        this.writeText(messageId, index, prior && textPart(prior) ? prior.text : '', part.text);
      } else if (prior && textPart(prior))
        this.query(
          'DELETE FROM message_text_chunks WHERE messageId=? AND partIndex=?',
          messageId,
          index,
        );
    }
    if (after.length < before.length) {
      this.query(
        'DELETE FROM message_parts WHERE messageId=? AND partIndex>=?',
        messageId,
        after.length,
      );
      this.query(
        'DELETE FROM message_text_chunks WHERE messageId=? AND partIndex>=?',
        messageId,
        after.length,
      );
    }
  }

  private writeText(messageId: string, partIndex: number, before: string, after: string) {
    if (before === after) return;
    let common = 0;
    if (after.startsWith(before)) common = before.length;
    else
      while (common < before.length && common < after.length && before[common] === after[common])
        common++;
    const start = Math.floor(common / CHUNK_CHARACTERS);
    if (common < before.length)
      this.query(
        'DELETE FROM message_text_chunks WHERE messageId=? AND partIndex=? AND ordinal>=?',
        messageId,
        partIndex,
        start,
      );
    for (let offset = start * CHUNK_CHARACTERS; offset < after.length; offset += CHUNK_CHARACTERS)
      this.query(
        'INSERT INTO message_text_chunks VALUES (?,?,?,?) ON CONFLICT(messageId,partIndex,ordinal) DO UPDATE SET payload=excluded.payload',
        messageId,
        partIndex,
        offset / CHUNK_CHARACTERS,
        JSON.stringify(after.slice(offset, offset + CHUNK_CHARACTERS)),
      );
  }

  /** MCP reads a channel in order without materializing every part or a full message. */
  page(messageId: string, channel: 'text' | 'reasoning', offset: number, limit = 8192) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 2 ||
      limit > 8192
    )
      throw new Error('Invalid message text cursor');
    const rows = this.query<{ partIndex: number; textLength: number }>(
      "SELECT partIndex,textLength FROM message_parts WHERE messageId=? AND json_extract(payload,'$.type')=? ORDER BY partIndex",
      messageId,
      channel,
    ).toArray();
    let skip = offset,
      text = '',
      total = 0;
    for (const row of rows) total += row.textLength;
    for (const row of rows) {
      if (skip >= row.textLength) {
        skip -= row.textLength;
        continue;
      }
      const needed = limit + 1 - text.length;
      if (needed <= 0) break;
      const ordinal = Math.floor(skip / CHUNK_CHARACTERS);
      const chunks = this.query<{ ordinal: number; payload: string }>(
        'SELECT ordinal,payload FROM message_text_chunks WHERE messageId=? AND partIndex=? AND ordinal>=? AND ordinal<=? ORDER BY ordinal',
        messageId,
        row.partIndex,
        ordinal,
        Math.floor((skip + needed - 1) / CHUNK_CHARACTERS),
      ).toArray();
      const suffix = chunks
        .map(({ ordinal: index, payload }, i) => {
          const value: unknown = JSON.parse(payload);
          if (index !== ordinal + i || typeof value !== 'string')
            throw new Error('Message text chunk gap');
          return value;
        })
        .join('')
        .slice(skip % CHUNK_CHARACTERS);
      if (suffix.length < Math.min(needed, row.textLength - skip))
        throw new Error('Message text length mismatch');
      text += suffix.slice(0, needed);
      skip = 0;
    }
    let end = Math.min(text.length, limit);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return { text: text.slice(0, end), hasMore: offset + end < total, nextOffset: offset + end };
  }

  erase(messageId: string) {
    this.query('DELETE FROM message_text_chunks WHERE messageId=?', messageId);
    this.query('DELETE FROM message_parts WHERE messageId=?', messageId);
  }
}
