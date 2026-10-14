import { DocumentStore } from './documents';
import type { DocumentPart } from '../shared/documents';
import { ATTACHMENT_LEASE, ATTACHMENT_UPLOAD_TIMEOUT, attachmentSignatureMatches, MAX_DAILY_ATTACHMENT_UPLOADS, MAX_CONVERSATION_ATTACHMENTS, MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_SPACE_ATTACHMENTS, MAX_SPACE_ATTACHMENT_BYTES, type Attachment, type AttachmentInput } from '../shared/attachments';
import { HttpError } from './http';
import { assertChatImage, imageMediaTypeSchema, MAX_MESSAGE_IMAGES, type ImagePart } from '../shared/images';
import * as v from 'valibot';

type Row = Attachment & { key: string; lease: number; token: string | null; removed: number } & Record<string, SqlStorageValue>;
export class AttachmentStore {
  readonly documents: DocumentStore;
  private active = new Set<string>();
  constructor(private storage: DurableObjectStorage, private bucket: R2Bucket | undefined, private exists: (id: string) => boolean) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, mediaType TEXT NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
      error TEXT, key TEXT NOT NULL, lease INTEGER NOT NULL, token TEXT, removed INTEGER NOT NULL DEFAULT 0)`);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS attachment_daily_uploads (date TEXT PRIMARY KEY, count INTEGER NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS attachment_usage (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
    this.documents = new DocumentStore(storage, bucket, this.require.bind(this), this.response.bind(this), (id) => {
      const row = this.row(id); if (row?.removed && row.status !== 'uploading') this.storage.sql.exec('UPDATE attachments SET lease = ? WHERE id = ?', Date.now(), id);
    });
  }
  private configuredBucket() {
    if (!this.bucket) throw new HttpError(503, '文件存储未配置，请先绑定私有 R2 桶。');
    return this.bucket;
  }
  private row(id: string) { return this.storage.sql.exec<Row>('SELECT * FROM attachments WHERE id = ?', id).toArray()[0]; }
  private public(row: Row): Attachment {
    const { id, conversationId, name, size, mediaType, sha256, status, createdAt, error } = row;
    return { id, conversationId, name, size, mediaType, sha256, status, createdAt, error };
  }
  private require(conversationId: string, id: string) {
    if (!this.exists(conversationId)) throw new HttpError(410, '对话不存在或已删除。');
    const row = this.row(id);
    if (!row || row.conversationId !== conversationId || row.removed) throw new HttpError(404, '找不到附件。');
    return row;
  }
  list(conversationId: string) {
    this.configuredBucket();
    if (!this.exists(conversationId)) throw new HttpError(410, '对话不存在或已删除。');
    return this.storage.sql.exec<Row>('SELECT * FROM attachments WHERE conversationId = ? AND removed = 0 ORDER BY createdAt, id', conversationId).toArray().map((row) => this.public(row));
  }
  images(conversationId: string, ids: string[]): ImagePart[] {
    this.configuredBucket();
    if (ids.length > MAX_MESSAGE_IMAGES || new Set(ids).size !== ids.length) throw new HttpError(400, '每条消息最多添加 4 张不同的图片。');
    return ids.map((id) => {
      const row = this.require(conversationId, id);
      if (row.status !== 'ready') throw new HttpError(409, '图片尚未上传完成。');
      const type = v.safeParse(imageMediaTypeSchema, row.mediaType);
      if (!type.success) throw new HttpError(415, '此附件不是支持的图片格式。');
      return { type: 'image', attachmentId: row.id, name: row.name, size: row.size, mediaType: type.output, sha256: row.sha256 };
    });
  }
  async pinAttachments(conversationId: string, images: ImagePart[], files: DocumentPart[]) {
    const unique = new Map(images.map((image) => [image.attachmentId, image]));
    for (const image of unique.values()) {
      const row = this.require(conversationId, image.attachmentId);
      if (row.status !== 'ready' || row.name !== image.name || row.size !== image.size || row.sha256 !== image.sha256 || row.mediaType !== image.mediaType) throw new HttpError(409, '图片引用与文件不符，请重新上传。');
      const response = await this.response(conversationId, image.attachmentId);
      try { assertChatImage(new Uint8Array(await response.arrayBuffer()), image.mediaType); }
      catch (error) { throw new HttpError(415, error instanceof Error ? error.message : '图片无效。'); }
    }
    const documents = new Map(files.map((file) => [file.attachmentId, file]));
    for (const file of documents.values()) await this.documents.validate(conversationId, file);
    const references = [...unique.values(), ...documents.values()];
    // Recheck every row after the last R2 await. A concurrent deletion must win before acceptance.
    for (const image of references) this.require(conversationId, image.attachmentId);
    this.storage.transactionSync(() => {
      for (const image of references) this.storage.sql.exec('INSERT INTO attachment_usage VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token', image.attachmentId, crypto.randomUUID());
    });
    await this.storage.sync();
  }
  usage(id: string) { return this.storage.sql.exec<{ token: string }>('SELECT token FROM attachment_usage WHERE id = ?', id).toArray()[0]?.token; }
  register(conversationId: string, input: AttachmentInput): Attachment {
    this.configuredBucket();
    if (!this.exists(conversationId)) throw new HttpError(410, '对话不存在或已删除。');
    return this.storage.transactionSync(() => {
      const existing = this.row(input.id);
      if (existing) {
        if (existing.removed || existing.conversationId !== conversationId || ['name', 'size', 'mediaType', 'sha256'].some((field) => existing[field] !== input[field as keyof AttachmentInput])) throw new HttpError(409, '此附件 ID 已被使用，请重新选择文件。');
        return this.public(existing);
      }
      const space = this.storage.sql.exec<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM attachments').one();
      const local = this.storage.sql.exec<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE conversationId = ?', conversationId).one();
      if (space.count >= MAX_SPACE_ATTACHMENTS || space.bytes + input.size > MAX_SPACE_ATTACHMENT_BYTES) throw new HttpError(507, '空间附件容量已满，请删除附件后重试。');
      if (local.count >= MAX_CONVERSATION_ATTACHMENTS || local.bytes + input.size > MAX_CONVERSATION_ATTACHMENT_BYTES) throw new HttpError(507, '此对话附件容量已满，请删除附件后重试。');
      const createdAt = Date.now();
      this.storage.sql.exec('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0)', input.id, conversationId, input.name, input.size,
        input.mediaType, input.sha256, 'registered', createdAt, `attachments/${conversationId}/${input.id}/${crypto.randomUUID()}`, createdAt + ATTACHMENT_LEASE);
      return this.public(this.row(input.id)!);
    });
  }
  async upload(conversationId: string, id: string, body: ReadableStream<Uint8Array>) {
    const bucket = this.configuredBucket();
    const row = this.require(conversationId, id);
    if (row.status === 'ready') { await body.cancel().catch(() => {}); return this.public(row); }
    if (row.status === 'uploading' || row.status === 'failed') { await body.cancel().catch(() => {}); throw new HttpError(409, '附件正在上传或已失败，请删除后重新选择。'); }
    const token = crypto.randomUUID();
    this.storage.transactionSync(() => {
      const date = new Date().toISOString().slice(0, 10);
      const attempts = this.storage.sql.exec<{ count: number }>('SELECT count FROM attachment_daily_uploads WHERE date = ?', date).toArray()[0]?.count ?? 0;
      if (attempts >= MAX_DAILY_ATTACHMENT_UPLOADS) throw new HttpError(429, '今日附件上传次数已达上限，请明天重试。');
      this.storage.sql.exec('DELETE FROM attachment_daily_uploads WHERE date < ?', date);
      this.storage.sql.exec('INSERT INTO attachment_daily_uploads VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET count = count + 1', date);
      this.storage.sql.exec("UPDATE attachments SET status = 'uploading', token = ?, lease = ? WHERE id = ?", token, Date.now() + ATTACHMENT_LEASE, id);
    });
    await this.storage.sync();
    this.active.add(id);
    const reader = body.getReader(), fixed = new FixedLengthStream(row.size), writer = fixed.writable.getWriter();
    let received = 0, prefix = new Uint8Array(), failure: unknown;
    const timer = setTimeout(() => {
      failure = new HttpError(408, '附件上传超时，请重新选择文件。');
      void reader.cancel().catch(() => {}); void writer.abort(failure).catch(() => {});
    }, ATTACHMENT_UPLOAD_TIMEOUT);
    const feed = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (failure) throw failure;
          if (done) break;
          received += value.byteLength;
          if (received > row.size) throw new HttpError(413, '附件实际大小超过声明大小。');
          if (prefix.length < Math.min(12, row.size)) {
            const joined = new Uint8Array(Math.min(12, prefix.length + value.length)); joined.set(prefix); joined.set(value.subarray(0, joined.length - prefix.length), prefix.length); prefix = joined;
            if (prefix.length === Math.min(12, row.size) && !attachmentSignatureMatches(prefix, row.mediaType)) throw new HttpError(415, '文件内容与类型不符。');
          }
          await writer.write(value);
        }
        if (received !== row.size) throw new HttpError(400, '附件未完整上传。');
        await writer.close();
      } catch (error) { failure = error; await reader.cancel().catch(() => {}); await writer.abort(error).catch(() => {}); throw error; }
    };
    const put = Promise.resolve().then(() => bucket.put(row.key, fixed.readable, { sha256: row.sha256, storageClass: 'Standard',
      httpMetadata: { contentType: row.mediaType }, customMetadata: { attachmentId: id, conversationId } }));
    const feeding = feed();
    try {
      const [object] = await Promise.all([put, feeding]);
      if (failure) throw failure;
      if (!object || object.size !== row.size) throw new HttpError(400, '附件未完整保存。');
      const current = this.row(id);
      if (!current || current.removed || current.token !== token || !this.exists(conversationId)) throw new HttpError(410, '附件或对话已删除。');
      this.storage.sql.exec("UPDATE attachments SET status = 'ready', token = NULL, lease = 0 WHERE id = ?", id);
      await this.storage.sync(); return this.public(this.row(id)!);
    } catch (error) {
      await reader.cancel().catch(() => {}); await writer.abort(error).catch(() => {});
      await Promise.allSettled([put, feeding]); // Do not delete the object while its R2 write could still complete.
      const current = this.row(id);
      if (current?.token === token) this.storage.sql.exec("UPDATE attachments SET status = 'failed', error = ?, token = NULL, lease = ? WHERE id = ?", '上传失败，未用于对话。请删除后重新选择文件。', Date.now(), id);
      // Keep the row and its reservation until cleanup is confirmed, including failed R2 writes.
      try { await bucket.delete(row.key); } catch { /* The durable cleanup queue retries. */ }
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, '附件上传或校验失败，请重新选择文件。');
    } finally { clearTimeout(timer); reader.releaseLock(); writer.releaseLock(); this.active.delete(id); }
  }
  async response(conversationId: string, id: string, head = false): Promise<Response> {
    const bucket = this.configuredBucket();
    const row = this.require(conversationId, id);
    if (row.status !== 'ready') throw new HttpError(409, '附件尚未上传完成。');
    const object = head ? await bucket.head(row.key) : await bucket.get(row.key);
    if (!object) throw new HttpError(404, '附件文件不存在。');
    try {
      const digest = object.checksums.sha256 ? Array.from(new Uint8Array(object.checksums.sha256), (byte) => byte.toString(16).padStart(2, '0')).join('') : null;
      if (object.size !== row.size || digest !== row.sha256) throw new HttpError(409, '附件完整性校验失败，请重新上传。');
      this.require(conversationId, id); // Deletion can interleave with the R2 read.
    } catch (error) {
      if ('body' in object) await (object as R2ObjectBody).body.cancel().catch(() => {});
      throw error;
    }
    const headers = new Headers({ 'Content-Type': row.mediaType, 'Content-Length': String(object.size), 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}` });
    return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers });
  }
  remove(conversationId: string, id: string, usage = this.usage(id)) {
    const row = this.require(conversationId, id);
    if (usage !== this.usage(id)) throw new HttpError(409, '文件刚被对话使用，请稍后重试。');
    this.storage.sql.exec('UPDATE attachments SET removed = 1, lease = ? WHERE id = ?', Math.max(row.status === 'uploading' ? row.lease : Date.now(), this.documents.lease(id)), id);
  }
  removeConversation(conversationId: string) {
    this.storage.sql.exec("UPDATE attachments SET removed = 1, lease = MAX(CASE WHEN status = 'uploading' THEN lease ELSE ? END, COALESCE((SELECT lease FROM attachment_documents WHERE attachment_documents.id = attachments.id AND status = 'parsing'), 0)) WHERE conversationId = ?", Date.now(), conversationId);
  }
  nextCleanup() {
    if (!this.bucket) return undefined;
    const next = this.storage.sql.exec<{ next: number }>("SELECT MIN(lease) AS next FROM attachments WHERE removed = 1 OR status != 'ready' HAVING COUNT(*) > 0").toArray()[0]?.next;
    const document = this.documents.nextCleanup();
    return next === undefined ? document : document === undefined ? next : Math.min(next, document);
  }
  async cleanup() {
    if (!this.bucket) return true;
    await this.documents.cleanup();
    let failed = false;
    const rows = this.storage.sql.exec<Row>("SELECT * FROM attachments WHERE (removed = 1 OR status != 'ready') AND lease <= ? ORDER BY lease LIMIT 4", Date.now()).toArray();
    for (const row of rows) {
      // Earlier R2 deletes yield to uploads. Recheck each row before claiming cleanup.
      const current = this.row(row.id);
      if (!current || current.key !== row.key || current.lease > Date.now() || (!current.removed && current.status === 'ready')) continue;
      if (this.active.has(row.id) || this.documents.isActive(row.id)) { this.storage.sql.exec('UPDATE attachments SET lease = ? WHERE id = ?', Date.now() + 30_000, row.id); continue; }
      // Close the registration synchronously so it cannot be uploaded while deletion awaits R2.
      this.storage.sql.exec('UPDATE attachments SET removed = 1 WHERE id = ?', row.id);
      try {
        await this.bucket.delete([row.key, `${row.key}/text-v1`]);
        const current = this.row(row.id);
        if (current && current.lease <= Date.now() && (current.removed || current.status !== 'ready')) {
          this.storage.sql.exec('DELETE FROM attachments WHERE id = ?', row.id);
          this.storage.sql.exec('DELETE FROM attachment_usage WHERE id = ?', row.id);
          this.documents.erase(row.id);
        }
      } catch { failed = true; this.storage.sql.exec('UPDATE attachments SET lease = ? WHERE id = ?', Date.now() + 30_000, row.id); }
    }
    return !failed;
  }
}
