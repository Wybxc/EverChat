import { createHash, randomBytes } from 'node:crypto';
import { problem } from '../../shared/errors/descriptor';
import type { ManagedShare, PublicShare, ShareBlock, SharePage } from '../../shared/sharing/types';
import type { SqlQuery } from '../generation/metrics';
import { HttpError } from '../http/response';

export interface ShareRow extends Record<string, SqlStorageValue> {
  id: string;
  operationId: string;
  conversationId: string;
  headId: string;
  sourceVersion: string;
  createdAt: number;
  updatedAt: number;
  draftUntil: number;
  status: 'draft' | 'active' | 'revoked';
  title: string;
  includeReasoning: number;
  messageCount: number;
  blockCount: number;
  omittedAttachments: number;
  hash: string;
  expiresAt: number | null;
  htmlCount: number;
}
export const unavailable = () =>
  new HttpError(404, '链接不可用。', undefined, problem('SHARE_UNAVAILABLE'));
export function publicShare(row: ShareRow): PublicShare {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    messageCount: row.messageCount,
    omittedAttachments: row.omittedAttachments,
    hash: row.hash,
  };
}
export class ShareRepository {
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {}
  get(id: string) {
    return this.query<ShareRow>('SELECT * FROM shares WHERE id=?', id).toArray()[0];
  }
  deleted(conversationId: string) {
    return (
      this.query(
        'SELECT conversationId FROM share_deletions WHERE conversationId=?',
        conversationId,
      ).toArray().length > 0
    );
  }
  managed(row: ShareRow): ManagedShare {
    return {
      ...publicShare(row),
      conversationId: row.conversationId,
      headId: row.headId,
      updatedAt: row.updatedAt,
      status:
        row.status === 'active' && row.expiresAt !== null && row.expiresAt <= this.now()
          ? 'expired'
          : row.status,
    };
  }
  begin(input: { operationId: string; conversationId: string; headId: string; title: string }) {
    if (this.deleted(input.conversationId))
      throw new HttpError(410, '这个对话已删除。', undefined, problem('CONVERSATION_DELETED'));
    const existing = this.query<ShareRow>(
      'SELECT * FROM shares WHERE operationId=?',
      input.operationId,
    ).toArray()[0];
    if (existing) {
      if (existing.conversationId !== input.conversationId || existing.headId !== input.headId)
        throw new HttpError(
          409,
          '预览操作已改变，请重新预览。',
          undefined,
          problem('SHARE_PREVIEW_STALE'),
        );
      if (existing.draftUntil <= this.now() && existing.status === 'draft')
        throw new HttpError(
          410,
          '预览已过期，请重新预览。',
          undefined,
          problem('SHARE_PREVIEW_STALE'),
        );
      return existing;
    }
    const id = randomBytes(16).toString('base64url'),
      now = this.now();
    this.query(
      `INSERT INTO shares VALUES (?, ?, ?, ?, '', ?, ?, ?, 'draft', ?, ?, 0, 0, 0, '', NULL, 0)`,
      id,
      input.operationId,
      input.conversationId,
      input.headId,
      now,
      now,
      now + 3_600_000,
      input.title,
      1,
    );
    return this.get(id)!;
  }
  resetDraft(id: string) {
    const row = this.get(id);
    if (!row || row.status !== 'draft') throw unavailable();
    this.query('DELETE FROM share_blocks WHERE shareId=?', id);
  }
  append(id: string, seq: number, block: ShareBlock) {
    this.query('INSERT INTO share_blocks VALUES (?, ?, ?)', id, seq, JSON.stringify(block));
  }
  finishDraft(
    id: string,
    sourceVersion: string,
    messageCount: number,
    blockCount: number,
    omittedAttachments: number,
    hash: string,
  ) {
    this.query(
      "UPDATE shares SET sourceVersion=?, messageCount=?, blockCount=?, omittedAttachments=?, hash=? WHERE id=? AND status='draft'",
      sourceVersion,
      messageCount,
      blockCount,
      omittedAttachments,
      hash,
      id,
    );
  }
  published(id: string) {
    const row = this.get(id);
    if (!row || row.status !== 'active' || (row.expiresAt !== null && row.expiresAt <= this.now()))
      throw unavailable();
    return row;
  }
  *html(row: ShareRow): Generator<string> {
    let count = 0;
    for (const part of this.query<{ seq: number; html: string }>(
      'SELECT seq, html FROM share_html WHERE shareId=? ORDER BY seq',
      row.id,
    )) {
      if (part.seq !== count++) throw new Error('Incomplete share HTML');
      yield part.html;
    }
    if (!count || count !== row.htmlCount) throw new Error('Incomplete share HTML');
  }
  saveHtml(id: string, parts: Iterable<string>) {
    this.query('DELETE FROM share_html WHERE shareId=?', id);
    let count = 0;
    for (const html of parts)
      this.query('INSERT INTO share_html VALUES (?, ?, ?)', id, count++, html);
    if (!count) throw new Error('Empty share HTML');
    this.query('UPDATE shares SET htmlCount=? WHERE id=?', count, id);
  }
  page(row: ShareRow, cursor = 0): SharePage {
    if (cursor < 0 || (cursor >= row.blockCount && cursor !== 0)) throw unavailable();
    const rows = this.query<{ seq: number; payload: string }>(
      'SELECT seq, payload FROM share_blocks WHERE shareId=? AND seq>=? ORDER BY seq LIMIT 4',
      row.id,
      cursor,
    ).toArray();
    const next = rows.at(-1)?.seq;
    return {
      blocks: rows.map((r) => JSON.parse(r.payload) as ShareBlock),
      cursor: next !== undefined && next + 1 < row.blockCount ? next + 1 : null,
    };
  }
  *payloads(row: ShareRow): Generator<string> {
    let count = 0;
    // Iterate the SQL cursor without materializing the full snapshot in the DO.
    for (const block of this.query<{ seq: number; payload: string }>(
      'SELECT seq, payload FROM share_blocks WHERE shareId=? ORDER BY seq',
      row.id,
    )) {
      if (block.seq !== count++) throw new Error('Incomplete share snapshot');
      yield block.payload;
    }
    if (count !== row.blockCount) throw new Error('Incomplete share snapshot');
  }
  publish(id: string, hash: string, title: string, expiresAt: number | null = null) {
    const row = this.get(id);
    if (!row || row.hash !== hash || !hash || this.deleted(row.conversationId)) throw unavailable();
    if (row.status === 'active') {
      if (this.managed(row).status !== 'active') throw unavailable();
      return row; // Lost response retries preserve the original link and expiration.
    }
    if (row.status !== 'draft' || row.draftUntil <= this.now()) throw unavailable();
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) ||
        expiresAt <= this.now() ||
        expiresAt > 8_640_000_000_000_000)
    )
      throw new HttpError(
        400,
        '请选择未来的有效到期时间。',
        undefined,
        problem('SHARE_EXPIRY_INVALID'),
      );
    const count = this.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM share_blocks WHERE shareId=?',
      id,
    ).one().count;
    if (!count || count !== row.blockCount)
      throw new HttpError(
        409,
        '快照尚未完整保存，请重新预览。',
        undefined,
        problem('SHARE_PREVIEW_STALE'),
      );
    if (
      !row.htmlCount ||
      this.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM share_html WHERE shareId=?',
        id,
      ).one().count !== row.htmlCount
    )
      throw new Error('Share HTML is not ready');
    this.query(
      "UPDATE shares SET status='active', title=?, updatedAt=?, expiresAt=? WHERE id=?",
      title,
      this.now(),
      expiresAt,
      id,
    );
    return this.get(id)!;
  }
  list(cursor?: { createdAt: number; id: string }) {
    const rows = this.query<ShareRow>(
      `SELECT * FROM shares WHERE status!='draft'${cursor ? ' AND (createdAt<? OR (createdAt=? AND id<?))' : ''} ORDER BY createdAt DESC, id DESC LIMIT 31`,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
    ).toArray();
    const page = rows.slice(0, 30),
      last = page.at(-1);
    return {
      shares: page.map((row) => this.managed(row)),
      cursor:
        rows.length > 30 && last
          ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id }))
          : null,
    };
  }
  deleteConversation(conversationId: string) {
    this.query('INSERT OR IGNORE INTO share_deletions VALUES (?)', conversationId);
    this.query(
      'DELETE FROM share_html WHERE shareId IN (SELECT id FROM shares WHERE conversationId=?)',
      conversationId,
    );
    this.query(
      'DELETE FROM share_blocks WHERE shareId IN (SELECT id FROM shares WHERE conversationId=?)',
      conversationId,
    );
    this.query('DELETE FROM shares WHERE conversationId=?', conversationId);
  }
  delete(id: string) {
    this.query('DELETE FROM share_html WHERE shareId=?', id);
    this.query('DELETE FROM share_blocks WHERE shareId=?', id);
    this.query('DELETE FROM shares WHERE id=?', id);
  }
  cleanup() {
    // No per-read writes. Reclamation is bounded and never revives expired snapshots.
    this.query(
      `DELETE FROM share_html WHERE (shareId, seq) IN (
      SELECT b.shareId, b.seq FROM share_html b JOIN shares s ON s.id=b.shareId
      WHERE s.status='revoked' OR (s.status='draft' AND s.draftUntil<=?)
      OR (s.status='active' AND s.expiresAt IS NOT NULL AND s.expiresAt<=?) LIMIT 128)`,
      this.now(),
      this.now(),
    );
    this.query(
      `DELETE FROM share_blocks WHERE (shareId, seq) IN (
      SELECT b.shareId, b.seq FROM share_blocks b JOIN shares s ON s.id=b.shareId
      WHERE s.status='revoked' OR (s.status='draft' AND s.draftUntil<=?)
      OR (s.status='active' AND s.expiresAt IS NOT NULL AND s.expiresAt<=?) LIMIT 128)`,
      this.now(),
      this.now(),
    );
    this.query(
      `DELETE FROM shares WHERE (status='revoked' OR (status='draft' AND draftUntil<=?)
      OR (status='active' AND expiresAt IS NOT NULL AND expiresAt<=?))
      AND NOT EXISTS (SELECT 1 FROM share_blocks WHERE shareId=shares.id)
      AND NOT EXISTS (SELECT 1 FROM share_html WHERE shareId=shares.id)`,
      this.now(),
      this.now(),
    );
  }
  nextCleanup() {
    const pending = this.query(
      `SELECT s.id FROM shares s WHERE
      (s.status='revoked' OR (s.status='draft' AND s.draftUntil<=?) OR
       (s.status='active' AND s.expiresAt IS NOT NULL AND s.expiresAt<=?))
      AND (EXISTS (SELECT 1 FROM share_blocks b WHERE b.shareId=s.id)
      OR EXISTS (SELECT 1 FROM share_html h WHERE h.shareId=s.id)) LIMIT 1`,
      this.now(),
      this.now(),
    ).toArray().length;
    if (pending) return this.now() + 1000;
    return this.query<{ at: number | null }>(
      `SELECT MIN(CASE WHEN status='draft' THEN draftUntil ELSE expiresAt END) AS at
      FROM shares WHERE status='draft' OR (status='active' AND expiresAt>?)`,
      this.now(),
    ).one().at;
  }
}

/** Hash incremental, bounded NDJSON without reassembling large messages in the HTTP Worker. */
export const snapshotHasher = () => createHash('sha256');
