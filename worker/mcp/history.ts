import type { SqlQuery } from '../generation/metrics';
import { GenerationCheckpoints } from '../streaming/checkpoints';
import { ConversationState } from '../conversation/state';
import { encodeRef, fail } from './contracts';

export const MCP_GRANTS_SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_conversation_grants (
  principal TEXT NOT NULL, conversationId TEXT NOT NULL, createdAt INTEGER NOT NULL,
  PRIMARY KEY(principal,conversationId)
) WITHOUT ROWID`;

export interface HistoryPosition {
  index: number;
  section: 'metadata' | 'content' | 'reasoning' | 'attachments' | 'summary' | 'tools';
  offset: number;
  item?: number;
}
export interface HistorySnapshot {
  seq: number;
  epoch: string;
}
export type HistoryRecord =
  | {
      kind: 'message';
      id: string;
      ref: string;
      parentId: string | null;
      revisionOf: string | null;
      role: string;
      status: string;
      deleted: boolean;
      createdAt: number;
      model: string | null;
      modelName: string | null;
      providerId: string | null;
      round: number;
      revision: number;
      summary: boolean;
      inputReceiptSteps: number;
    }
  | {
      kind: 'text';
      messageId: string;
      channel: 'content' | 'reasoning' | 'tools';
      offset: number;
      text: string;
      final: boolean;
    }
  | {
      kind: 'attachment';
      messageId: string;
      index: number;
      offset: number;
      json: string;
      final: boolean;
    }
  | {
      kind: 'summary';
      messageId: string;
      offset: number;
      sourceIds: string[];
      throughId: string;
      final: boolean;
    };

// UNION bounds malformed cycles without a guessed maximum conversation length.
const path = `WITH RECURSIVE path(id,parentId) AS (
 SELECT id,parentId FROM messages WHERE id=?
 UNION SELECT messages.id,messages.parentId FROM messages JOIN path ON messages.id=path.parentId
)`;

/** Read a fixed, durable branch in bounded records; never materialize full bodies. */
export class McpHistory {
  private readonly journal;
  constructor(private readonly query: SqlQuery) {
    this.journal = new GenerationCheckpoints(query);
  }
  branches(after: number) {
    const rows = this.query<{
      id: string;
      ordinal: number;
      createdAt: number;
      status: string;
      role: string;
    }>(
      `SELECT id,rowid AS ordinal,createdAt,status,role FROM messages AS m
       WHERE rowid>? AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=m.id)
       AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE messageId=m.id)
       AND NOT EXISTS (SELECT 1 FROM messages AS child WHERE child.parentId=m.id
         AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE messageId=child.id)
         AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=child.id))
       ORDER BY rowid LIMIT 17`,
      after,
    ).toArray();
    return { heads: rows.slice(0, 16), hasMore: rows.length > 16 };
  }
  private ids(headId: string) {
    const rows = this.query<{ id: string; parentId: string | null; role: string }>(
      `${path} SELECT messages.id,messages.parentId,messages.role FROM messages JOIN path USING(id)`,
      headId,
    ).toArray();
    if (!rows.length) fail('HEAD_NOT_FOUND', 'This branch head is unavailable.', 'retrieval');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ids: string[] = [],
      visited = new Set<string>();
    let id: string | null = headId;
    while (id) {
      if (visited.has(id) || !byId.has(id))
        fail('INVALID_BRANCH', 'This branch has a missing or cyclic parent.', 'retrieval');
      visited.add(id);
      ids.push(id);
      id = byId.get(id)!.parentId;
    }
    ids.reverse();
    // Summaries are visible records beside the parent chain. Only exact covered
    // prefixes belong here; a sibling branch's summary must never be included.
    const summaries = this.query<{ id: string; payload: string }>(
      `SELECT messageId AS id,payload FROM message_summaries WHERE NOT EXISTS
       (SELECT 1 FROM message_deletions WHERE id=messageId) ORDER BY (SELECT rowid FROM messages WHERE id=messageId)`,
    ).toArray();
    const extras = new Map<string, string[]>();
    for (const row of summaries) {
      const coverage = JSON.parse(row.payload) as { sourceIds: string[]; throughId: string };
      if (
        !byId.has(row.id) &&
        coverage.sourceIds.length <= ids.length &&
        coverage.sourceIds.every((value, i) => ids[i] === value)
      )
        extras.set(coverage.throughId, [...(extras.get(coverage.throughId) ?? []), row.id]);
    }
    let round = 0;
    return ids.flatMap((id) => {
      if (byId.get(id)!.role === 'user') round++;
      return [id, ...(extras.get(id) ?? [])].map((value) => ({ id: value, round }));
    });
  }
  read(
    conversationId: string,
    headId: string,
    options: {
      snapshot?: HistorySnapshot;
      position?: HistoryPosition;
      includeReasoning: boolean;
      includeTools: boolean;
      includeActive: boolean;
      fromRound?: number;
      toRound?: number;
    },
  ) {
    const snapshot = new ConversationState(this.query).current();
    if (
      options.snapshot &&
      (snapshot.seq !== options.snapshot.seq || snapshot.epoch !== options.snapshot.epoch)
    )
      fail(
        'SNAPSHOT_CHANGED',
        'The conversation changed. Restart this branch read without a cursor.',
        'retrieval',
      );
    const ids = this.ids(headId);
    const active =
      this.query<{ count: number }>(
        `${path} SELECT COUNT(*) AS count FROM messages JOIN path USING(id) WHERE status IN ('queued','running')`,
        headId,
      ).one().count > 0;
    if (active && !options.includeActive)
      fail(
        'BRANCH_ACTIVE',
        'This branch is still generating. Wait, or explicitly include its durable partial output.',
        'retrieval',
      );
    let pos: HistoryPosition = options.position ?? { index: 0, section: 'metadata', offset: 0 };
    if (pos.index > ids.length)
      fail('INVALID_CURSOR', 'This cursor is outside the branch.', 'retrieval');
    const records: HistoryRecord[] = [];
    let bytes = 0;
    const append = (record: HistoryRecord) => {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length && bytes + size > 24 * 1024) return false;
      if (size > 24 * 1024)
        fail('RECORD_TOO_LARGE', 'This record exceeds the response byte budget.', 'retrieval');
      records.push(record);
      bytes += size;
      return true;
    };
    while (pos.index < ids.length && records.length < 8) {
      const { id, round: turn } = ids[pos.index];
      if (
        (options.fromRound !== undefined && turn < options.fromRound) ||
        (options.toRound !== undefined && turn > options.toRound)
      ) {
        pos = { index: pos.index + 1, section: 'metadata', offset: 0 };
        continue;
      }
      const raw = this.query<{
        id: string;
        parentId: string | null;
        revisionOf: string | null;
        role: string;
        status: string;
        createdAt: number;
        model: string | null;
        modelName: string | null;
        providerId: string | null;
        deleted: number;
        revision: number;
      }>(
        `SELECT m.id,m.parentId,m.revisionOf,m.role,m.status,m.createdAt,m.model,m.modelName,m.providerId,
         EXISTS(SELECT 1 FROM message_deletions WHERE id=m.id) AS deleted,
         COALESCE((SELECT version FROM message_versions WHERE messageId=m.id),0) AS revision FROM messages AS m WHERE id=?`,
        id,
      ).one();
      const summaryRow = this.query<{ payload: string }>(
        'SELECT payload FROM message_summaries WHERE messageId=?',
        id,
      ).toArray()[0];
      const next = (section: HistoryPosition['section']) => ({
        index: pos.index,
        section,
        offset: 0,
      });
      let record: HistoryRecord | undefined, after: HistoryPosition;
      if (pos.section === 'metadata') {
        const steps = this.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM input_receipts WHERE messageId=?',
          id,
        ).one().count;
        record = {
          kind: 'message',
          ...raw,
          deleted: Boolean(raw.deleted),
          ref: encodeRef('message1', [conversationId, id]),
          round: turn,
          summary: Boolean(summaryRow),
          inputReceiptSteps: steps,
        };
        after = next('content');
      } else if (pos.section === 'content' || pos.section === 'reasoning') {
        const channel = pos.section;
        if (!raw.deleted && (channel === 'content' || options.includeReasoning)) {
          const page = this.journal.page(id, channel, pos.offset, 2048);
          if ('error' in page) fail('INVALID_CURSOR', 'Invalid message text cursor.', 'retrieval');
          record = {
            kind: 'text',
            messageId: id,
            channel,
            offset: pos.offset,
            text: page.text,
            final: !page.hasMore,
          };
          after = page.hasMore
            ? { ...pos, offset: page.nextOffset }
            : next(channel === 'content' ? 'reasoning' : 'attachments');
        } else after = next(channel === 'content' ? 'reasoning' : 'attachments');
      } else if (pos.section === 'attachments') {
        // json_each + bounded substr avoids loading a whole attachment array or
        // a very large PDF range list in order to return a metadata page.
        const entry = this.query<{ json: string; length: number; index: number }>(
          `SELECT substr(value,?,2048) AS json,length(value) AS length,key AS 'index' FROM (
           SELECT value,key FROM json_each(COALESCE((SELECT payload FROM message_images WHERE messageId=?),'[]'))
           UNION ALL SELECT value,key+1000000000 AS key FROM json_each(COALESCE((SELECT payload FROM message_files WHERE messageId=?),'[]'))
          ) WHERE key>=? ORDER BY key LIMIT 1`,
          pos.offset + 1,
          id,
          id,
          pos.item ?? 0,
        ).toArray()[0];
        if (entry && !raw.deleted) {
          const charOffset = pos.offset,
            index = entry.index;
          // SQL substr counts Unicode points; offset here is explicitly an opaque cursor.
          const used = Array.from(entry.json).length;
          const final = charOffset + used >= entry.length;
          record = {
            kind: 'attachment',
            messageId: id,
            index,
            offset: charOffset,
            json: entry.json,
            final,
          };
          after = final
            ? { ...pos, offset: 0, item: index + 1 }
            : { ...pos, offset: charOffset + used, item: index };
        } else after = next('summary');
      } else if (pos.section === 'summary') {
        if (summaryRow && !raw.deleted) {
          const summary = JSON.parse(summaryRow.payload) as {
            sourceIds: string[];
            throughId: string;
          };
          const sourceIds = summary.sourceIds.slice(pos.offset, pos.offset + 32),
            end = pos.offset + sourceIds.length;
          record = {
            kind: 'summary',
            messageId: id,
            offset: pos.offset,
            sourceIds,
            throughId: summary.throughId,
            final: end >= summary.sourceIds.length,
          };
          after = end < summary.sourceIds.length ? { ...pos, offset: end } : next('tools');
        } else after = next('tools');
      } else {
        const value =
          options.includeTools && !raw.deleted
            ? this.query<{ text: string; length: number }>(
                'SELECT substr(payload,?,2048) AS text,length(payload) AS length FROM message_web_tools WHERE messageId=?',
                pos.offset + 1,
                id,
              ).toArray()[0]
            : undefined;
        const end = pos.offset + (value ? Array.from(value.text).length : 0);
        if (value)
          record = {
            kind: 'text',
            messageId: id,
            channel: 'tools',
            offset: pos.offset,
            text: value.text,
            final: end >= value.length,
          };
        after =
          value && end < value.length
            ? { ...pos, offset: end }
            : { index: pos.index + 1, section: 'metadata', offset: 0 };
      }
      if (record && !append(record)) break;
      pos = after;
    }
    return {
      snapshot,
      headId,
      partial: active,
      records,
      position: pos.index < ids.length ? pos : null,
    };
  }
}

export function markdownRecords(records: HistoryRecord[]) {
  // JSON fences keep attachment names/metadata and tool results inert. Long
  // bodies remain raw Markdown; concatenating pages recreates the document.
  return records
    .map((record) => {
      if (record.kind === 'message')
        return `\n\n## ${record.summary ? 'Summary' : record.role === 'user' ? 'User' : 'Assistant'} · Round ${record.round}\n\n${JSON.stringify({ id: record.id, parentId: record.parentId, model: record.model, modelName: record.modelName, createdAt: record.createdAt, status: record.status, deleted: record.deleted })}\n\n`;
      if (record.kind === 'text') {
        if (record.channel === 'content') return record.text;
        const open =
          record.offset === 0
            ? `\n\n<details><summary>${record.channel === 'reasoning' ? 'Reasoning' : 'Tools'}</summary>\n\n${record.channel === 'tools' ? '````````````````````````````````json\n' : ''}`
            : '';
        return (
          open +
          record.text +
          (record.final
            ? `${record.channel === 'tools' ? '\n````````````````````````````````' : ''}\n\n</details>\n`
            : '')
        );
      }
      if (record.kind === 'attachment')
        return (
          (record.offset === 0
            ? '\n\nAttachment metadata:\n\n````````````````````````````````json\n'
            : '') +
          record.json +
          (record.final ? '\n````````````````````````````````\n' : '')
        );
      return `\n\nSummary coverage: ${JSON.stringify(record.sourceIds)}\n`;
    })
    .join('');
}
