import type { SqlQuery } from '../generation/metrics';
import { CHUNK_CHARACTERS, GenerationCheckpoints } from '../streaming/checkpoints';

/** Bounded reads over immutable prefix references; no full answer materialization. */
export class ConversationContent {
  private readonly journal;
  constructor(private readonly query: SqlQuery) {
    this.journal = new GenerationCheckpoints(query);
  }
  page(
    id: string,
    channel: 'content' | 'reasoning',
    offset: number,
    limit = 8192,
  ):
    | { error: 'invalid_cursor'; text?: never; hasMore?: never; nextOffset?: never }
    | { text: string; hasMore: boolean; nextOffset: number; error?: never } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2)
      return { error: 'invalid_cursor' as const };
    // Resolve the chain and each bounded tail chunk in one query. UNION also
    // terminates malformed cycles; the ordered walk below rejects them.
    const rows = this.query<{
      id: string;
      sourceId: string | null;
      ordinal: number | null;
      payload: string | null;
      value: string | null;
    }>(
      `WITH RECURSIVE chain(id) AS (
      SELECT ? UNION SELECT c.sourceId FROM message_continuations c JOIN chain ON c.messageId=chain.id WHERE c.sourceId!=''
    ) SELECT m.id,c.sourceId,t.ordinal,t.payload,m.${channel === 'content' ? 'content' : 'reasoning'} AS value
      FROM chain JOIN messages m USING(id) LEFT JOIN message_continuations c ON c.messageId=m.id
      LEFT JOIN message_content_chunks t ON t.messageId=m.id AND t.channel=? AND t.ordinal=(
        SELECT MAX(ordinal) FROM message_content_chunks WHERE messageId=m.id AND channel=?)`,
      id,
      channel,
      channel,
    ).toArray();
    const byId = new Map(rows.map((row) => [row.id, row])),
      segments: { messageId: string; length: number }[] = [],
      seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) throw new Error('Cyclic answer continuation');
      seen.add(current);
      const row = byId.get(current);
      if (!row) throw new Error('Missing answer continuation source');
      segments.push({
        messageId: current,
        length:
          row.payload === null
            ? (row.value ?? '').length
            : row.ordinal! * CHUNK_CHARACTERS + (JSON.parse(row.payload) as string).length,
      });
      current = row.sourceId;
    }
    segments.reverse();
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (offset > length) return { error: 'invalid_cursor' as const };
    let relative = offset,
      text = '';
    for (const segment of segments) {
      if (relative >= segment.length) {
        relative -= segment.length;
        continue;
      }
      if (limit - text.length < 2) break;
      const page = this.journal.page(segment.messageId, channel, relative, limit - text.length);
      if (page.error) return page;
      text += page.text;
      if (page.hasMore) break;
      relative = 0;
    }
    return { text, hasMore: offset + text.length < length, nextOffset: offset + text.length };
  }
}
