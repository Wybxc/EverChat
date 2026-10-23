import * as v from 'valibot';
import { documentKey, type DocumentPart } from '../../shared/attachments/documents';
import {
  ATTACHMENT_LEASE,
  ATTACHMENT_UPLOAD_TIMEOUT,
  attachmentSignatureMatches,
  type Attachment,
  type AttachmentInput,
  type AttachmentUpload,
} from '../../shared/attachments/files';
import {
  assertChatImage,
  imageMediaTypeSchema,
  type ImagePart,
} from '../../shared/attachments/images';
import { issueOf, problem } from '../../shared/errors/descriptor';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import { HttpError } from '../http/response';
import { DocumentStore } from './documents';
import type { UploadSigner } from './signing';

// Keep a fixed expiry across retries. The lease also covers an upload that
// started just before URL expiry; deleting a registration must not reopen it.
const directExpiry = (token: string | null) =>
  token?.startsWith('direct:') ? Number(token.slice(7)) : null;
const UPLOAD_CLEANUP_GRACE = 15 * 60_000;

type Row = Attachment & {
  key: string;
  lease: number;
  token: string | null;
  removed: number;
} & Record<string, SqlStorageValue>;
export class AttachmentStore {
  readonly documents: DocumentStore;
  private active = new Set<string>();
  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket | undefined,
    private exists: (id: string) => boolean,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, mediaType TEXT NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
      error TEXT, key TEXT NOT NULL, lease INTEGER NOT NULL, token TEXT, removed INTEGER NOT NULL DEFAULT 0)`);
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS attachment_usage (id TEXT PRIMARY KEY, token TEXT NOT NULL)',
    );
    this.documents = new DocumentStore(
      storage,
      bucket,
      this.require.bind(this),
      this.response.bind(this),
      (id) => {
        const row = this.row(id);
        if (row?.removed && row.status !== 'uploading')
          this.storage.sql.exec(
            'UPDATE attachments SET lease = ? WHERE id = ?',
            directExpiry(row.token) === null ? Date.now() : Math.max(row.lease, Date.now()),
            id,
          );
      },
    );
  }
  private configuredBucket() {
    if (!this.bucket)
      throw new HttpError(
        503,
        '文件存储未配置，请先绑定私有 R2 桶。',
        undefined,
        problem('ATTACHMENT_STORAGE_REQUIRED'),
      );
    return this.bucket;
  }
  private row(id: string) {
    return this.storage.sql.exec<Row>('SELECT * FROM attachments WHERE id = ?', id).toArray()[0];
  }
  private public(row: Row): Attachment {
    const { id, conversationId, name, size, mediaType, sha256, status, createdAt, error } = row;
    return { id, conversationId, name, size, mediaType, sha256, status, createdAt, error };
  }
  private require(conversationId: string, id: string) {
    if (!this.exists(conversationId))
      throw new HttpError(410, '对话不存在或已删除。', undefined, problem('ATTACHMENT_INVALID'));
    const row = this.row(id);
    if (!row || row.conversationId !== conversationId || row.removed)
      throw new HttpError(404, '找不到附件。', undefined, problem('NOT_FOUND'));
    return row;
  }
  list(conversationId: string) {
    this.configuredBucket();
    if (!this.exists(conversationId))
      throw new HttpError(410, '对话不存在或已删除。', undefined, problem('ATTACHMENT_INVALID'));
    return this.storage.sql
      .exec<Row>(
        'SELECT * FROM attachments WHERE conversationId = ? AND removed = 0 ORDER BY createdAt, id',
        conversationId,
      )
      .toArray()
      .map((row) => this.public(row));
  }
  hasSaved(conversationId: string) {
    return Boolean(
      this.storage.sql
        .exec(
          "SELECT id FROM attachments WHERE conversationId = ? AND removed = 0 AND status = 'ready' LIMIT 1",
          conversationId,
        )
        .toArray().length,
    );
  }
  unconfirmed(id: string) {
    const row = this.row(id);
    return Boolean(row && ['uploading', 'failed'].includes(row.status) && !this.active.has(id));
  }
  archiveFiles(conversationId: string) {
    return this.list(conversationId)
      .filter((file) => file.status === 'ready')
      .map(({ id, name, size, mediaType, sha256 }) => {
        const parsed = this.documents.archiveReference(conversationId, id);
        return { id, name, size, mediaType, sha256, ...(parsed ? { parsed } : {}) };
      });
  }
  images(conversationId: string, ids: string[]): ImagePart[] {
    this.configuredBucket();
    if (new Set(ids).size !== ids.length)
      throw new HttpError(400, '图片引用不能重复。', undefined, problem('ATTACHMENT_INVALID'));
    return ids.map((id) => {
      const row = this.require(conversationId, id);
      if (row.status !== 'ready')
        throw new HttpError(409, '图片尚未上传完成。', undefined, problem('ATTACHMENT_INVALID'));
      const type = v.safeParse(imageMediaTypeSchema, row.mediaType);
      if (!type.success)
        throw new HttpError(
          415,
          '此附件不是支持的图片格式。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      return {
        type: 'image',
        attachmentId: row.id,
        name: row.name,
        size: row.size,
        mediaType: type.output,
        sha256: row.sha256,
      };
    });
  }
  async pinAttachments(conversationId: string, images: ImagePart[], files: DocumentPart[]) {
    const unique = new Map(images.map((image) => [image.attachmentId, image]));
    for (const image of unique.values()) {
      const row = this.require(conversationId, image.attachmentId);
      if (
        row.status !== 'ready' ||
        row.name !== image.name ||
        row.size !== image.size ||
        row.sha256 !== image.sha256 ||
        row.mediaType !== image.mediaType
      )
        throw new HttpError(
          409,
          '图片引用与文件不符，请重新上传。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      const response = await this.response(conversationId, image.attachmentId, false, true);
      try {
        assertChatImage(new Uint8Array(await response.arrayBuffer()), image.mediaType);
      } catch (error) {
        throw new HttpError(
          415,
          error instanceof Error ? error.message : '图片无效。',
          undefined,
          issueOf(error, 'ATTACHMENT_INVALID'),
        );
      }
    }
    const documents = new Map(files.map((file) => [documentKey(file), file]));
    for (const file of documents.values()) await this.documents.validate(conversationId, file);
    const references = [...unique.values(), ...documents.values()];
    // Recheck every row after the last R2 await. A concurrent deletion must win before acceptance.
    for (const image of references) this.require(conversationId, image.attachmentId);
    this.storage.transactionSync(() => {
      for (const image of references)
        this.storage.sql.exec(
          'INSERT INTO attachment_usage VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token',
          image.attachmentId,
          crypto.randomUUID(),
        );
    });
    await this.storage.sync();
  }
  usage(id: string) {
    return this.storage.sql
      .exec<{ token: string }>('SELECT token FROM attachment_usage WHERE id = ?', id)
      .toArray()[0]?.token;
  }
  async clone(sourceId: string, targetId: string, id: string, cloneId: string) {
    const source = this.require(sourceId, id);
    if (source.status !== 'ready')
      throw new HttpError(
        409,
        '待复制文件尚未保存完成。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const parsed = this.documents.parsedReference(sourceId, id);
    const document = parsed ? await this.documents.read(sourceId, id) : undefined;
    this.register(targetId, {
      id: cloneId,
      name: source.name,
      size: source.size,
      mediaType: source.mediaType,
      sha256: source.sha256,
    });
    const response = await this.response(sourceId, id);
    if (!response.body)
      throw new HttpError(503, '待复制文件内容不可用。', undefined, problem('ATTACHMENT_INVALID'));
    try {
      await this.upload(targetId, cloneId, response.body);
    } finally {
      await response.body.cancel().catch(() => {});
    }
    this.require(sourceId, id);
    if (document) {
      const result = await this.documents.parse(
        targetId,
        cloneId,
        document.file.pdf
          ? {
              sourceSha256: source.sha256,
              text: document.text,
              pdf: document.file.pdf,
              ...(document.pageOffsets ? { pageOffsets: document.pageOffsets } : {}),
            }
          : undefined,
      );
      if (JSON.stringify({ ...result, attachmentId: id }) !== JSON.stringify(document.file))
        throw new HttpError(
          409,
          '复制后的解析资料与原文件不符。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
    }
    this.require(sourceId, id);
    this.require(targetId, cloneId);
  }
  register(conversationId: string, input: AttachmentInput): Attachment {
    this.configuredBucket();
    if (!this.exists(conversationId))
      throw new HttpError(410, '对话不存在或已删除。', undefined, problem('ATTACHMENT_INVALID'));
    return this.storage.transactionSync(() => {
      const existing = this.row(input.id);
      if (existing) {
        if (
          existing.removed ||
          existing.conversationId !== conversationId ||
          ['name', 'size', 'mediaType', 'sha256'].some(
            (field) => existing[field] !== input[field as keyof AttachmentInput],
          )
        )
          throw new HttpError(
            409,
            '此附件 ID 已被使用，请重新选择文件。',
            undefined,
            problem('ATTACHMENT_INVALID'),
          );
        return this.public(existing);
      }
      const createdAt = Date.now();
      this.storage.sql.exec(
        'INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0)',
        input.id,
        conversationId,
        input.name,
        input.size,
        input.mediaType,
        input.sha256,
        'registered',
        createdAt,
        `attachments/${conversationId}/${input.id}/${crypto.randomUUID()}`,
        createdAt + ATTACHMENT_LEASE,
      );
      return this.public(this.row(input.id)!);
    });
  }
  async prepareUploads(
    conversationId: string,
    inputs: AttachmentInput[],
    sign: UploadSigner,
  ): Promise<AttachmentUpload[]> {
    if (new Set(inputs.map((input) => input.id)).size !== inputs.length)
      throw new HttpError(400, '附件 ID 不能重复。', undefined, problem('ATTACHMENT_INVALID'));
    const rows = this.storage.transactionSync(() =>
      inputs.map((input) => {
        const attachment = this.register(conversationId, input);
        let row = this.require(conversationId, input.id);
        if (row.status === 'ready') return row;
        if (row.status !== 'registered')
          throw new HttpError(
            409,
            '附件状态不可上传，请重新选择文件。',
            undefined,
            problem('ATTACHMENT_INVALID'),
          );
        if (directExpiry(row.token) === null) {
          const expiresAt = attachment.createdAt + ATTACHMENT_LEASE;
          this.storage.sql.exec(
            'UPDATE attachments SET token = ?, lease = ? WHERE id = ?',
            `direct:${expiresAt}`,
            expiresAt + UPLOAD_CLEANUP_GRACE,
            row.id,
          );
          row = this.require(conversationId, row.id);
        }
        return row;
      }),
    );
    await this.storage.sync();
    const result: AttachmentUpload[] = [];
    for (const row of rows) {
      const upload =
        row.status === 'ready'
          ? null
          : await sign(row.key, row.mediaType, directExpiry(row.token)!);
      this.require(conversationId, row.id);
      result.push({ attachment: this.public(row), upload });
    }
    return result;
  }
  async receive(conversationId: string, id: string): Promise<Attachment> {
    const row = this.require(conversationId, id);
    if (row.status === 'ready') return this.public(row);
    if (row.status !== 'registered' || directExpiry(row.token) === null || row.lease <= Date.now())
      throw new HttpError(
        409,
        '附件尚未就绪或登记已过期。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const object = await this.configuredBucket().head(row.key);
    const current = this.require(conversationId, id);
    if (current.status === 'ready') return this.public(current);
    if (
      current.token !== row.token ||
      current.status !== 'registered' ||
      current.lease <= Date.now()
    )
      throw new HttpError(409, '附件状态已变化。', undefined, problem('ATTACHMENT_INVALID'));
    if (!object)
      throw new HttpError(
        409,
        '文件尚未上传完成，请重试。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    if (object.size !== row.size || object.httpMetadata?.contentType !== row.mediaType)
      throw new HttpError(
        400,
        '上传文件的大小或类型与登记不符，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    this.storage.sql.exec("UPDATE attachments SET status = 'ready' WHERE id = ?", id);
    await this.storage.sync();
    return this.public(this.require(conversationId, id));
  }
  async upload(conversationId: string, id: string, body: ReadableStream<Uint8Array>) {
    const bucket = this.configuredBucket();
    const row = this.require(conversationId, id);
    if (row.status === 'ready') {
      await body.cancel().catch(() => {});
      return this.public(row);
    }
    if (row.status === 'uploading' || row.status === 'failed') {
      await body.cancel().catch(() => {});
      throw new HttpError(
        409,
        '附件正在上传或已失败，请删除后重新选择。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    }
    const token = crypto.randomUUID();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE attachments SET status = 'uploading', token = ?, lease = ? WHERE id = ?",
        token,
        Date.now() + ATTACHMENT_LEASE,
        id,
      );
    });
    await this.storage.sync();
    this.active.add(id);
    const reader = body.getReader(),
      fixed = new FixedLengthStream(row.size),
      writer = fixed.writable.getWriter();
    let received = 0,
      prefix = new Uint8Array(),
      failure: unknown;
    const timer = setTimeout(() => {
      failure = new HttpError(
        408,
        '附件上传超时，请重新选择文件。',
        undefined,
        problem('REQUEST_TIMEOUT'),
      );
      void reader.cancel().catch(() => {});
      void writer.abort(failure).catch(() => {});
    }, ATTACHMENT_UPLOAD_TIMEOUT);
    const feed = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (failure) throw failure;
          if (done) break;
          received += value.byteLength;
          if (received > row.size)
            throw new HttpError(
              413,
              '附件实际大小超过声明大小。',
              undefined,
              problem('ATTACHMENT_INVALID'),
            );
          if (prefix.length < Math.min(12, row.size)) {
            const joined = new Uint8Array(Math.min(12, prefix.length + value.length));
            joined.set(prefix);
            joined.set(value.subarray(0, joined.length - prefix.length), prefix.length);
            prefix = joined;
            if (
              prefix.length === Math.min(12, row.size) &&
              !attachmentSignatureMatches(prefix, row.mediaType)
            )
              throw new HttpError(
                415,
                '文件内容与类型不符。',
                undefined,
                problem('ATTACHMENT_INVALID'),
              );
          }
          await writer.write(value);
        }
        if (received !== row.size)
          throw new HttpError(400, '附件未完整上传。', undefined, problem('ATTACHMENT_INVALID'));
        await writer.close();
      } catch (error) {
        failure = error;
        await reader.cancel().catch(() => {});
        await writer.abort(error).catch(() => {});
        throw error;
      }
    };
    const put = Promise.resolve().then(() =>
      bucket.put(row.key, fixed.readable, {
        sha256: row.sha256,
        storageClass: 'Standard',
        httpMetadata: { contentType: row.mediaType },
        customMetadata: { attachmentId: id, conversationId },
      }),
    );
    const feeding = feed();
    try {
      const [object] = await Promise.all([put, feeding]);
      if (failure) throw failure;
      if (!object || object.size !== row.size)
        throw new HttpError(400, '附件未完整保存。', undefined, problem('ATTACHMENT_INVALID'));
      const current = this.row(id);
      if (!current || current.removed || current.token !== token || !this.exists(conversationId))
        throw new HttpError(410, '附件或对话已删除。', undefined, problem('ATTACHMENT_INVALID'));
      this.storage.sql.exec(
        "UPDATE attachments SET status = 'ready', token = NULL, lease = 0 WHERE id = ?",
        id,
      );
      await this.storage.sync();
      return this.public(this.row(id)!);
    } catch (error) {
      await reader.cancel().catch(() => {});
      await writer.abort(error).catch(() => {});
      await Promise.allSettled([put, feeding]); // Do not delete the object while its R2 write could still complete.
      const current = this.row(id);
      if (current?.token === token)
        this.storage.sql.exec(
          "UPDATE attachments SET status = 'failed', error = ?, token = NULL, lease = ? WHERE id = ?",
          '上传失败，未用于对话。请删除后重新选择文件。',
          Date.now(),
          id,
        );
      // Keep the row and its reservation until cleanup is confirmed, including failed R2 writes.
      try {
        await bucket.delete(row.key);
      } catch {
        /* The durable cleanup queue retries. */
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        400,
        '附件上传或校验失败，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      writer.releaseLock();
      this.active.delete(id);
    }
  }
  async response(
    conversationId: string,
    id: string,
    head = false,
    imageHeader = false,
  ): Promise<Response> {
    const bucket = this.configuredBucket();
    const row = this.require(conversationId, id);
    if (row.status !== 'ready')
      throw new HttpError(409, '附件尚未上传完成。', undefined, problem('ATTACHMENT_INVALID'));
    // Pinning only needs format/dimensions. Do not load a 100 MB original just
    // to inspect its header during a copy/restore or before model admission.
    const length = imageHeader ? Math.min(row.size, MAX_SQL_PAYLOAD_BYTES) : row.size;
    const object = head
      ? await bucket.head(row.key)
      : await bucket.get(row.key, imageHeader ? { range: { offset: 0, length } } : undefined);
    if (!object)
      throw new HttpError(404, '附件文件不存在。', undefined, problem('ATTACHMENT_INVALID'));
    try {
      if (object.size !== row.size || object.httpMetadata?.contentType !== row.mediaType)
        throw new HttpError(
          409,
          '附件完整性校验失败，请重新上传。',
          undefined,
          problem('ATTACHMENT_INVALID'),
        );
      this.require(conversationId, id); // Deletion can interleave with the R2 read.
    } catch (error) {
      if ('body' in object) await (object as R2ObjectBody).body.cancel().catch(() => {});
      throw error;
    }
    const headers = new Headers({
      'Content-Type': row.mediaType,
      'Content-Length': String(length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    });
    return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers });
  }
  remove(conversationId: string, id: string, usage = this.usage(id)) {
    const row = this.require(conversationId, id);
    if (usage !== this.usage(id))
      throw new HttpError(
        409,
        '文件刚被对话使用，请稍后重试。',
        undefined,
        problem('ATTACHMENT_IN_USE'),
      );
    this.storage.sql.exec(
      'UPDATE attachments SET removed = 1, lease = ? WHERE id = ?',
      Math.max(
        row.status === 'uploading' || directExpiry(row.token) !== null ? row.lease : Date.now(),
        this.documents.lease(id),
      ),
      id,
    );
  }
  removeConversation(conversationId: string) {
    this.storage.sql.exec(
      "UPDATE attachments SET removed = 1, lease = MAX(CASE WHEN status = 'uploading' OR token LIKE 'direct:%' THEN lease ELSE ? END, COALESCE((SELECT lease FROM attachment_documents WHERE attachment_documents.id = attachments.id AND status = 'parsing'), 0)) WHERE conversationId = ?",
      Date.now(),
      conversationId,
    );
  }
  nextCleanup() {
    if (!this.bucket) return undefined;
    const next = this.storage.sql
      .exec<{ next: number }>(
        "SELECT MIN(lease) AS next FROM attachments WHERE removed = 1 OR status != 'ready' HAVING COUNT(*) > 0",
      )
      .toArray()[0]?.next;
    const document = this.documents.nextCleanup();
    return next === undefined ? document : document === undefined ? next : Math.min(next, document);
  }
  async cleanup() {
    if (!this.bucket) return true;
    await this.documents.cleanup();
    let failed = false;
    const rows = this.storage.sql
      .exec<Row>(
        "SELECT * FROM attachments WHERE (removed = 1 OR status != 'ready') AND lease <= ? ORDER BY lease LIMIT 4",
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      // Earlier R2 deletes yield to uploads. Recheck each row before claiming cleanup.
      const current = this.row(row.id);
      if (
        !current ||
        current.key !== row.key ||
        current.lease > Date.now() ||
        (!current.removed && current.status === 'ready')
      )
        continue;
      if (this.active.has(row.id) || this.documents.isActive(row.id)) {
        this.storage.sql.exec(
          'UPDATE attachments SET lease = ? WHERE id = ?',
          Date.now() + 30_000,
          row.id,
        );
        continue;
      }
      // Close the registration synchronously so it cannot be uploaded while deletion awaits R2.
      this.storage.sql.exec('UPDATE attachments SET removed = 1 WHERE id = ?', row.id);
      try {
        await this.bucket.delete([row.key, `${row.key}/text-v1`]);
        const current = this.row(row.id);
        if (
          current &&
          current.lease <= Date.now() &&
          (current.removed || current.status !== 'ready')
        ) {
          this.storage.sql.exec('DELETE FROM attachments WHERE id = ?', row.id);
          this.storage.sql.exec('DELETE FROM attachment_usage WHERE id = ?', row.id);
          this.documents.erase(row.id);
        }
      } catch {
        failed = true;
        this.storage.sql.exec(
          'UPDATE attachments SET lease = ? WHERE id = ?',
          Date.now() + 30_000,
          row.id,
        );
      }
    }
    return !failed;
  }
}
