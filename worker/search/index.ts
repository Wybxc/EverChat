import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
  searchCandidateGlob,
  normalizeSearch,
  SEARCH_PAGE_SIZE,
  type LibrarySearch,
  type SearchDocument,
} from '../../shared/search/query';

type Node = { type: string; value?: string; alt?: string | null; children?: Node[] };
const blocks = new Set(['paragraph', 'heading', 'listItem', 'code', 'blockquote', 'tableCell']);
export function searchableMarkdown(markdown: string): string {
  const read = (node: Node): string => {
    if (['html', 'definition'].includes(node.type)) return '';
    if (node.type === 'image' || node.type === 'imageReference')
      return `[图片：${node.alt ?? '附件'}]`;
    if (node.type === 'break') return '\n';
    const text = node.value ?? node.children?.map(read).join('') ?? '';
    return blocks.has(node.type) ? `${text}\n` : text;
  };
  return read(
    fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  ).trim();
}

export const MAX_SEARCH_DATABASE_BYTES = 256 * 1024 * 1024;
export const SEARCH_CAPACITY_MESSAGE = '搜索索引已达到容量限制，请删除不需要的对话后重试。';
export class SearchChanged extends Error {}
export const searchRetryDelay = (attempts: number) =>
  Math.min(30 * 60_000, 30_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
type FieldRow = {
  id: number;
  conversationId: string;
  messageId: string;
  field: 'content' | 'reasoning';
  text: string;
  normalized: string;
} & Record<string, SqlStorageValue>;

export class SearchIndex {
  constructor(private storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS search_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL)',
    );
    sql.exec('INSERT OR IGNORE INTO search_revision VALUES (1, 0)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS search_messages (conversationId TEXT NOT NULL, messageId TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(conversationId, messageId))',
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS search_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL, messageId TEXT NOT NULL,
      field TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(conversationId, messageId, field))`);
    // External content avoids another full copy; detail=none omits token positions.
    sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(normalized, content='search_fields', content_rowid='id', tokenize='trigram case_sensitive 1', detail=none)`,
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS search_backfill (conversationId TEXT PRIMARY KEY, after INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS search_problems (conversationId TEXT PRIMARY KEY, error TEXT NOT NULL)',
    );
  }
  changed() {
    this.storage.sql.exec('UPDATE search_revision SET revision = revision + 1 WHERE id = 1');
  }
  private eraseFields(conversationId: string, messageId?: string) {
    const sql = this.storage.sql;
    const predicate = messageId ? 'conversationId = ? AND messageId = ?' : 'conversationId = ?';
    const bindings = messageId ? [conversationId, messageId] : [conversationId];
    for (const row of sql.exec<FieldRow>(
      `SELECT * FROM search_fields WHERE ${predicate}`,
      ...bindings,
    )) {
      sql.exec(
        "INSERT INTO search_fts(search_fts, rowid, normalized) VALUES ('delete', ?, ?)",
        row.id,
        row.normalized,
      );
    }
    sql.exec(`DELETE FROM search_fields WHERE ${predicate}`, ...bindings);
  }
  replace(conversationId: string, documents: SearchDocument[]) {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      for (const document of documents) {
        const current = sql
          .exec<{ version: number }>(
            'SELECT version FROM search_messages WHERE conversationId = ? AND messageId = ?',
            conversationId,
            document.messageId,
          )
          .toArray()[0];
        if (current && current.version >= document.version) continue;
        this.eraseFields(conversationId, document.messageId);
        for (const field of ['content', 'reasoning'] as const) {
          const text =
            document.role === 'user' ? document[field] : searchableMarkdown(document[field]);
          const normalized = normalizeSearch(text);
          if (!normalized) continue;
          const id = sql
            .exec<{ id: number }>(
              'INSERT INTO search_fields(conversationId, messageId, field, text, normalized) VALUES (?, ?, ?, ?, ?) RETURNING id',
              conversationId,
              document.messageId,
              field,
              text,
              normalized,
            )
            .one().id;
          sql.exec('INSERT INTO search_fts(rowid, normalized) VALUES (?, ?)', id, normalized);
        }
        sql.exec(
          'INSERT INTO search_messages VALUES (?, ?, ?) ON CONFLICT(conversationId, messageId) DO UPDATE SET version = excluded.version',
          conversationId,
          document.messageId,
          document.version,
        );
        this.changed();
      }
      if (sql.databaseSize > MAX_SEARCH_DATABASE_BYTES) throw new Error(SEARCH_CAPACITY_MESSAGE);
    });
  }
  remove(conversationId: string) {
    this.storage.transactionSync(() => {
      this.eraseFields(conversationId);
      this.storage.sql.exec('DELETE FROM search_messages WHERE conversationId = ?', conversationId);
      this.storage.sql.exec('DELETE FROM search_backfill WHERE conversationId = ?', conversationId);
      this.storage.sql.exec('DELETE FROM search_problems WHERE conversationId = ?', conversationId);
      this.changed();
    });
  }
  search(query: string, archived: boolean, cursor?: string): LibrarySearch {
    const sql = this.storage.sql,
      normalized = normalizeSearch(query);
    const revision = sql
      .exec<{ revision: number }>('SELECT revision FROM search_revision WHERE id = 1')
      .one().revision;
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      let parsed: { q: string; a: boolean; r: number; b: number };
      try {
        parsed = JSON.parse(decodeURIComponent(atob(cursor)));
      } catch {
        throw new SearchChanged('搜索游标无效，请重新搜索。');
      }
      if (
        parsed.q !== normalized ||
        parsed.a !== archived ||
        parsed.r !== revision ||
        !Number.isSafeInteger(parsed.b) ||
        parsed.b < 1
      )
        throw new SearchChanged('搜索内容已更新，请重新搜索。');
      before = parsed.b;
    }
    const rows = normalized
      ? sql
          .exec<FieldRow & { title: string }>(
            `SELECT fields.*, conversations.title FROM search_fts
      JOIN search_fields AS fields ON fields.id = search_fts.rowid JOIN conversations ON conversations.id = fields.conversationId
      LEFT JOIN conversation_metadata AS metadata ON metadata.id = conversations.id
      WHERE search_fts.normalized GLOB ? AND instr(fields.normalized, ?) > 0 AND fields.id < ? AND COALESCE(metadata.archived, 0) = ?
      AND NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = fields.conversationId)
      ORDER BY fields.id DESC LIMIT ?`,
            searchCandidateGlob(normalized),
            normalized,
            before,
            Number(archived),
            SEARCH_PAGE_SIZE + 1,
          )
          .toArray()
      : [];
    const page = rows.slice(0, SEARCH_PAGE_SIZE);
    const pattern = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    return {
      results: page.map((row) => {
        const display = row.text.replace(/\s+/gu, ' ').trim();
        const start = Math.max(
          0,
          (pattern.exec(display)?.index ?? row.normalized.indexOf(normalized)) - 40,
        );
        return {
          conversationId: row.conversationId,
          title: row.title,
          messageId: row.messageId,
          field: row.field,
          excerpt: `${start ? '…' : ''}${display.slice(start, start + Math.max(120, normalized.length + 40))}${display.length > start + Math.max(120, normalized.length + 40) ? '…' : ''}`,
        };
      }),
      cursor:
        rows.length > SEARCH_PAGE_SIZE
          ? btoa(
              encodeURIComponent(
                JSON.stringify({ q: normalized, a: archived, r: revision, b: page.at(-1)!.id }),
              ),
            )
          : null,
      indexing: Boolean(
        sql.exec('SELECT conversationId FROM search_backfill WHERE done = 0 LIMIT 1').toArray()
          .length,
      ),
      ...(sql.exec<{ error: string }>('SELECT error FROM search_problems LIMIT 1').toArray()[0] ??
        {}),
    };
  }
}
