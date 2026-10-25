import { createHash } from 'node:crypto';
import {
  documentPrompt,
  type DocumentPart,
  type DocumentInputSnapshot,
} from '../../shared/attachments/documents';

export const DOCUMENT_INPUT_SNAPSHOTS_SCHEMA = `CREATE TABLE IF NOT EXISTS document_input_snapshots (
  attachmentId TEXT NOT NULL, sha256 TEXT NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL,
  characters INTEGER NOT NULL, etag TEXT, PRIMARY KEY(attachmentId,sha256)
) WITHOUT ROWID`;
type Row = {
  attachmentId: string;
  sha256: string;
  key: string;
  bytes: number;
  characters: number;
  etag: string | null;
} & Record<string, SqlStorageValue>;

/** Immutable, deduplicated logical input; binary payloads and per-request copies never enter SQL. */
export class DocumentInputSnapshots {
  private active = new Map<string, Promise<DocumentInputSnapshot>>();
  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket | undefined,
    private source: (conversationId: string, id: string) => { key: string },
  ) {
    storage.sql.exec(DOCUMENT_INPUT_SNAPSHOTS_SCHEMA);
  }
  isActive(id: string) {
    return [...this.active.keys()].some((key) => key.startsWith(`${id}:`));
  }
  private row(id: string, hash: string) {
    return this.storage.sql
      .exec<Row>(
        'SELECT * FROM document_input_snapshots WHERE attachmentId=? AND sha256=?',
        id,
        hash,
      )
      .toArray()[0];
  }
  capture(conversationId: string, file: DocumentPart, text: string) {
    const prompt = documentPrompt(file, text),
      bytes = new TextEncoder().encode(prompt),
      sha256 = createHash('sha256').update(bytes).digest('hex'),
      key = `${file.attachmentId}:${sha256}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const result = this.save(conversationId, file.attachmentId, bytes, {
      version: 1,
      sha256,
      bytes: bytes.length,
      characters: prompt.length,
    });
    this.active.set(key, result);
    void result.finally(() => this.active.delete(key)).catch(() => {});
    return result;
  }
  private async save(
    conversationId: string,
    id: string,
    bytes: Uint8Array,
    snapshot: DocumentInputSnapshot,
  ) {
    const source = this.source(conversationId, id),
      bucket = this.bucket;
    if (!bucket) throw new Error('Document input storage is unavailable');
    let row = this.row(id, snapshot.sha256);
    if (row?.etag) return snapshot;
    // Reserve the object key before I/O so deletion can always find interrupted writes.
    const key = `${source.key}/input-v1/${snapshot.sha256}`;
    this.storage.sql.exec(
      'INSERT OR IGNORE INTO document_input_snapshots VALUES (?,?,?,?,?,NULL)',
      id,
      snapshot.sha256,
      key,
      snapshot.bytes,
      snapshot.characters,
    );
    await this.storage.sync();
    let object = await bucket.head(key);
    if (!object)
      object = await bucket.put(key, bytes, {
        sha256: snapshot.sha256,
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
    this.source(conversationId, id);
    if (
      !object ||
      object.size !== snapshot.bytes ||
      !object.checksums.sha256 ||
      Buffer.from(object.checksums.sha256).toString('hex') !== snapshot.sha256
    )
      throw new Error('Document input snapshot verification failed');
    this.storage.sql.exec(
      'UPDATE document_input_snapshots SET etag=? WHERE attachmentId=? AND sha256=?',
      object.etag,
      id,
      snapshot.sha256,
    );
    await this.storage.sync();
    return snapshot;
  }
  async page(conversationId: string, id: string, snapshot: DocumentInputSnapshot, offset: number) {
    const unavailable = {
      state: 'content_unavailable' as const,
      text: '',
      nextOffset: offset,
      hasMore: false,
    };
    if (!this.bucket) return unavailable;
    try {
      this.source(conversationId, id);
    } catch {
      return unavailable;
    }
    const row = this.row(id, snapshot.sha256);
    if (!row?.etag || row.bytes !== snapshot.bytes || row.characters !== snapshot.characters)
      return unavailable;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.bytes)
      return { ...unavailable, state: 'invalid_cursor' as const };
    if (offset === row.bytes) return { ...unavailable, state: 'available' as const };
    const object = await this.bucket.get(row.key, {
      onlyIf: { etagMatches: row.etag },
      range: { offset, length: Math.min(8196, row.bytes - offset) },
    });
    if (!object || !('body' in object)) return unavailable;
    const bytes = new Uint8Array(await object.arrayBuffer());
    try {
      this.source(conversationId, id);
    } catch {
      return unavailable;
    }
    if ((bytes[0] & 0xc0) === 0x80) return { ...unavailable, state: 'invalid_cursor' as const };
    let end = Math.min(8192, bytes.length);
    if (end < bytes.length) while (end && (bytes[end] & 0xc0) === 0x80) end--;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      return unavailable;
    }
    const nextOffset = offset + end;
    return { state: 'available' as const, text, nextOffset, hasMore: nextOffset < row.bytes };
  }
  async cleanup(id: string) {
    if (this.isActive(id)) return false;
    const rows = this.storage.sql
      .exec<Row>('SELECT * FROM document_input_snapshots WHERE attachmentId=? LIMIT 16', id)
      .toArray();
    if (rows.length && !this.bucket) return false;
    if (rows.length) {
      await this.bucket!.delete(rows.map((row) => row.key));
      for (const row of rows)
        this.storage.sql.exec(
          'DELETE FROM document_input_snapshots WHERE attachmentId=? AND sha256=?',
          id,
          row.sha256,
        );
    }
    return !this.storage.sql
      .exec('SELECT 1 FROM document_input_snapshots WHERE attachmentId=? LIMIT 1', id)
      .toArray().length;
  }
}
