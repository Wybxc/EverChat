import { createHash } from 'node:crypto';
import { ATTACHMENT_LEASE } from '../../shared/attachments/files';
import { type DocumentPart, type DocumentRange } from '../../shared/attachments/documents';
import type { ImagePart } from '../../shared/attachments/images';
import type { PDFExtraction } from '../../shared/attachments/pdf';
import { pageRanges } from '../../shared/attachments/pdf-selection';
import { AttachmentStore } from '../attachments/store';
import type { UploadSigner } from '../attachments/signing';
import { readPdfUpload } from '../attachments/pdf-upload';
import { HttpError } from '../http/response';
import { readErrorIssue } from '../../shared/errors/descriptor';
import { MAX_MESSAGE_TEXT_BYTES } from '../../shared/conversation/limits';
import { decodeRef, encodeRef, fail, McpError, type ChatArguments } from './contracts';
import type { McpRecord } from './store';
import type { MaterialBinding } from '../../shared/attachments/materials';
import type {
  AttachmentsPrepareArguments,
  AttachmentsPutArguments,
  AttachmentsGetArguments,
  AttachmentsResult,
} from './attachment-contracts';

export const MCP_ATTACHMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_uploads (
 principal TEXT NOT NULL,uploadId TEXT NOT NULL,fingerprint TEXT NOT NULL,conversationId TEXT NOT NULL,
 continuation TEXT,requestId TEXT,createdAt INTEGER NOT NULL,PRIMARY KEY(principal,uploadId)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mcp_upload_files (
 principal TEXT NOT NULL,uploadId TEXT NOT NULL,ordinal INTEGER NOT NULL,attachmentId TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(principal,uploadId,ordinal)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mcp_upload_files_owner ON mcp_upload_files(principal,attachmentId);
CREATE TABLE IF NOT EXISTS mcp_attachment_parts (
 attachmentId TEXT PRIMARY KEY,key TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
 expiresAt INTEGER NOT NULL,lease INTEGER NOT NULL,cleaned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mcp_attachment_parts_cleanup ON mcp_attachment_parts(cleaned,lease)`;
type Batch = {
  principal: string;
  uploadId: string;
  fingerprint: string;
  conversationId: string;
  continuation: string | null;
  requestId: string | null;
  createdAt: number;
} & Record<string, SqlStorageValue>;
type FileData = AttachmentsPrepareArguments['files'][number] & {
  documentId: string;
  supersedes: string | null;
  createdAt: number;
};
type FileRow = {
  principal: string;
  uploadId: string;
  ordinal: number;
  attachmentId: string;
  payload: string;
  deleted: number;
} & Record<string, SqlStorageValue>;
type Part = {
  attachmentId: string;
  key: string;
  size: number;
  sha256: string;
  expiresAt: number;
  lease: number;
  cleaned: number;
} & Record<string, SqlStorageValue>;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type ResolvedAttachments = {
  conversationId: string;
  parentId: string | null;
  images: ImagePart[];
  files: DocumentPart[];
  materialBindings: Record<string, MaterialBinding>;
};

export function mcpAttachmentFailure(error: unknown) {
  if (error instanceof McpError) return error.detail;
  if (error instanceof HttpError)
    return {
      code: error.issue?.code ?? error.code ?? 'ATTACHMENT_INVALID',
      message: error.message,
      stage: 'attachments',
      retryable: [408, 409, 503].includes(error.status),
      httpStatus: error.status,
    };
  return {
    code: 'ATTACHMENT_OUTCOME_UNKNOWN',
    message: 'File operation could not be confirmed. Retry the same uploadId and input.',
    stage: 'attachments',
    retryable: true,
  };
}

/** The existing Library owns this index and its R2 lifecycle; no separate upload service. */
export class McpAttachments {
  constructor(
    private storage: DurableObjectStorage,
    private attachments: AttachmentStore,
    private bucket: R2Bucket | undefined,
    private origin: string,
    private keyExists: (key: string) => boolean,
    private exists: (id: string) => boolean,
    private create: (id: string) => unknown,
    private request: (principal: string, id: string) => McpRecord | undefined,
    private signer: () => UploadSigner,
    private remove: (conversationId: string, id: string) => Promise<unknown>,
  ) {}
  private authorize(principal: string) {
    if (!this.keyExists(principal))
      fail('MCP_KEY_REVOKED', 'This API key was revoked.', 'authorization');
  }
  private batch(principal: string, ref: string) {
    this.authorize(principal);
    const [conversationId, uploadId] = decodeRef('upload1', ref, 2);
    const row = this.storage.sql
      .exec<Batch>(
        'SELECT * FROM mcp_uploads WHERE principal=? AND uploadId=?',
        principal,
        uploadId,
      )
      .toArray()[0];
    if (!row || row.conversationId !== conversationId || !this.exists(conversationId))
      fail('UPLOAD_UNAVAILABLE', 'This upload is not available to this API key.', 'authorization');
    return row;
  }
  private file(principal: string, ref: string, allowDeleted = false) {
    this.authorize(principal);
    const [conversationId, id] = decodeRef('attachment1', ref, 2);
    const row = this.storage.sql
      .exec<FileRow>(
        'SELECT * FROM mcp_upload_files WHERE principal=? AND attachmentId=?',
        principal,
        id,
      )
      .toArray()[0];
    if (!row || (row.deleted && !allowDeleted))
      fail(
        'ATTACHMENT_ACCESS_DENIED',
        'This file is not available to this API key.',
        'authorization',
      );
    const batch = this.batch(principal, encodeRef('upload1', [conversationId, row.uploadId]));
    return { row, batch, data: JSON.parse(row.payload) as FileData };
  }
  private parent(principal: string, continuation?: string) {
    if (!continuation) return null;
    const [conversationId, requestId, assistantId] = decodeRef('continue1', continuation, 3),
      parent = this.request(principal, requestId);
    if (
      !parent ||
      parent.conversationId !== conversationId ||
      parent.submission?.assistantId !== assistantId ||
      !this.exists(conversationId)
    )
      fail(
        'PARENT_UNAVAILABLE',
        'This continuation is unavailable to this API key.',
        'authorization',
      );
    return { conversationId, parentId: assistantId };
  }
  private register(principal: string, input: AttachmentsPrepareArguments, direct: boolean) {
    this.authorize(principal);
    const fingerprint = hash(
      JSON.stringify({ continuation: input.continuation ?? null, direct, files: input.files }),
    );
    return this.storage.transactionSync(() => {
      const old = this.storage.sql
        .exec<Batch>(
          'SELECT * FROM mcp_uploads WHERE principal=? AND uploadId=?',
          principal,
          input.uploadId,
        )
        .toArray()[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          fail(
            'IDEMPOTENCY_CONFLICT',
            'This uploadId has different file metadata, content or target.',
          );
        return this.batch(principal, encodeRef('upload1', [old.conversationId, input.uploadId]));
      }
      if (new Set(input.files.map((f) => f.clientFileId)).size !== input.files.length)
        fail('INVALID_ARGUMENT', 'clientFileId values must be unique.');
      const parent = this.parent(principal, input.continuation),
        conversationId = parent?.conversationId ?? crypto.randomUUID(),
        createdAt = Date.now();
      const files = input.files.map((file) => {
        if ((file.purpose === 'image') !== file.mediaType.startsWith('image/'))
          fail('INVALID_ARGUMENT', 'File purpose and media type disagree.');
        if (file.pdfText && file.mediaType !== 'application/pdf')
          fail('INVALID_ARGUMENT', 'Only PDF accepts a pdfText upload.');
        let documentId: string = crypto.randomUUID();
        if (file.replaces) {
          const source = this.file(principal, file.replaces);
          if (
            !parent ||
            source.batch.conversationId !== conversationId ||
            file.purpose !== 'document' ||
            source.data.purpose !== 'document'
          )
            fail(
              'INVALID_ARGUMENT',
              'Replacement must be a document in this exact continued conversation.',
            );
          documentId = source.data.documentId;
        }
        return {
          id: crypto.randomUUID(),
          data: {
            ...file,
            documentId,
            supersedes: file.replaces ?? null,
            createdAt,
          } satisfies FileData,
        };
      });
      if (!parent) {
        const created = this.create(conversationId);
        if (created && typeof created === 'object' && 'error' in created)
          fail('CONVERSATION_UNAVAILABLE', 'Unable to create an attachment conversation.');
        this.storage.sql.exec(
          'INSERT INTO mcp_conversation_grants VALUES (?,?,?)',
          principal,
          conversationId,
          createdAt,
        );
      }
      this.storage.sql.exec(
        'INSERT INTO mcp_uploads VALUES (?,?,?,?,?,NULL,?)',
        principal,
        input.uploadId,
        fingerprint,
        conversationId,
        input.continuation ?? null,
        createdAt,
      );
      for (const [ordinal, { id, data }] of files.entries()) {
        this.attachments.register(conversationId, {
          id,
          name: data.name,
          mediaType: data.mediaType,
          size: data.size,
          sha256: data.sha256,
        });
        this.storage.sql.exec(
          'INSERT INTO mcp_upload_files VALUES (?,?,?,?,?,0)',
          principal,
          input.uploadId,
          ordinal,
          id,
          JSON.stringify(data),
        );
        if (data.pdfText && direct)
          this.storage.sql.exec(
            'INSERT INTO mcp_attachment_parts VALUES (?,?,?,?,?,?,0)',
            id,
            `mcp-pdf/${conversationId}/${id}/${crypto.randomUUID()}`,
            data.pdfText.size,
            data.pdfText.sha256,
            createdAt + ATTACHMENT_LEASE,
            createdAt + ATTACHMENT_LEASE + 15 * 60_000,
          );
      }
      return this.batch(principal, encodeRef('upload1', [conversationId, input.uploadId]));
    });
  }
  async prepare(principal: string, input: AttachmentsPrepareArguments) {
    // Check signing configuration before creating any registration.
    this.signer();
    const batch = this.register(principal, input, true),
      ref = encodeRef('upload1', [batch.conversationId, batch.uploadId]);
    return this.get(principal, { uploadRef: ref, view: 'uploads' });
  }
  async put(principal: string, input: AttachmentsPutArguments) {
    const bytes = input.files.map((f) => {
      if (f.text !== undefined) {
        if (!f.mediaType.startsWith('text/'))
          fail('INVALID_ARGUMENT', 'text is only supported for UTF-8 text files.');
        return Buffer.from(f.text, 'utf8');
      }
      const value = f.dataBase64!;
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
        !value.length
      )
        fail('INVALID_ARGUMENT', 'dataBase64 must be canonical padded base64.');
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value)
        fail('INVALID_ARGUMENT', 'Invalid base64 encoding.');
      return decoded;
    });
    const files = input.files.map(({ text: _, dataBase64: __, extraction, ...metadata }, i) => ({
      ...metadata,
      size: bytes[i].length,
      sha256: hash(bytes[i]),
    }));
    // The input digest also binds an inline PDF extraction; never retain its body in the batch index.
    const prepared = {
      uploadId: input.uploadId,
      continuation: input.continuation,
      files: files.map((f, i) =>
        input.files[i].extraction
          ? {
              ...f,
              pdfText: {
                size: Buffer.byteLength(JSON.stringify(input.files[i].extraction)),
                sha256: hash(JSON.stringify(input.files[i].extraction)),
              },
            }
          : f,
      ),
    };
    const batch = this.register(principal, prepared, false);
    const rows = this.storage.sql
      .exec<FileRow>(
        'SELECT * FROM mcp_upload_files WHERE principal=? AND uploadId=? ORDER BY ordinal',
        principal,
        input.uploadId,
      )
      .toArray();
    for (const row of rows) {
      this.file(principal, encodeRef('attachment1', [batch.conversationId, row.attachmentId]));
      const body = new Response(bytes[row.ordinal]).body!;
      await this.attachments.upload(batch.conversationId, row.attachmentId, body);
      this.authorize(principal);
      const file = input.files[row.ordinal];
      if (
        file.purpose === 'document' &&
        (file.mediaType !== 'application/pdf' || file.extraction)
      ) {
        await this.attachments.documents.parse(
          batch.conversationId,
          row.attachmentId,
          file.extraction,
        );
        this.authorize(principal);
      }
    }
    return this.get(principal, {
      uploadRef: encodeRef('upload1', [batch.conversationId, batch.uploadId]),
      view: 'metadata',
    });
  }
  private part(id: string) {
    return this.storage.sql
      .exec<Part>('SELECT * FROM mcp_attachment_parts WHERE attachmentId=?', id)
      .toArray()[0];
  }
  async get(principal: string, input: AttachmentsGetArguments): Promise<AttachmentsResult> {
    const selected = input.attachmentRef ? this.file(principal, input.attachmentRef) : undefined,
      batch = selected?.batch ?? this.batch(principal, input.uploadRef!);
    let offset = 0;
    if (input.cursor) {
      const [id, view, file, value] = decodeRef('attachments1', input.cursor, 4);
      offset = Number(value);
      if (
        id !== batch.uploadId ||
        view !== input.view ||
        file !== (input.attachmentRef ?? '') ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        fail('INVALID_CURSOR', 'This file cursor does not match the read.');
    }
    const base: AttachmentsResult = {
      uploadRef: encodeRef('upload1', [batch.conversationId, batch.uploadId]),
      conversationId: batch.conversationId,
      url: `${this.origin}/c/${batch.conversationId}`,
      files: [],
      text: null,
      textUnit: null,
      hasMore: false,
      nextCursor: null,
    };
    const cursor = (at: number) =>
      encodeRef('attachments1', [
        batch.uploadId,
        input.view,
        input.attachmentRef ?? '',
        String(at),
      ]);
    if (input.view === 'text') {
      if (!selected) fail('INVALID_ARGUMENT', 'Text preview requires attachmentRef.');
      const parsed = this.attachments.documents.parsedReference(
        batch.conversationId,
        selected.row.attachmentId,
      );
      if (!parsed) fail('ATTACHMENT_NOT_READY', 'This document has no saved extracted text.');
      // Text previews use existing immutable extracted text with a byte-range read.
      const page = await this.attachments.documents.previewPage(
        batch.conversationId,
        selected.row.attachmentId,
        offset,
      );
      this.file(principal, input.attachmentRef!);
      if (page.state !== 'available')
        fail(
          page.state === 'invalid_cursor' ? 'INVALID_CURSOR' : 'CONTENT_UNAVAILABLE',
          'This document preview is unavailable.',
        );
      return {
        ...base,
        text: page.text,
        textUnit: 'utf8_bytes',
        hasMore: page.hasMore,
        nextCursor: page.hasMore ? cursor(page.nextOffset) : null,
      };
    }
    const rows = selected
      ? [selected.row]
      : this.storage.sql
          .exec<FileRow>(
            'SELECT * FROM mcp_upload_files WHERE principal=? AND uploadId=? AND ordinal>=? ORDER BY ordinal LIMIT 17',
            principal,
            batch.uploadId,
            offset,
          )
          .toArray();
    let pageBytes = Buffer.byteLength(JSON.stringify(base)),
      nextOffset = offset;
    for (const row of rows.slice(0, 16)) {
      const data = JSON.parse(row.payload) as FileData,
        attachmentRef = encodeRef('attachment1', [batch.conversationId, row.attachmentId]);
      let status = 'deleted',
        inputStatus = 'deleted',
        error: string | null = null,
        parsed: DocumentPart | undefined;
      const uploads: AttachmentsResult['files'][number]['uploads'] = [];
      if (!row.deleted) {
        try {
          const attachment = this.attachments.metadata(batch.conversationId, row.attachmentId);
          status = attachment.status;
          error = attachment.error;
          const uploaded = await this.attachments.uploaded(batch.conversationId, row.attachmentId);
          this.file(principal, attachmentRef);
          parsed =
            data.purpose === 'document'
              ? this.attachments.documents.parsedReference(batch.conversationId, row.attachmentId)
              : undefined;
          inputStatus =
            parsed || (data.purpose === 'image' && status === 'ready')
              ? 'ready'
              : uploaded
                ? data.mediaType === 'application/pdf' && !data.pdfText
                  ? 'awaiting_extraction'
                  : 'preparing'
                : 'awaiting_upload';
          if (input.view === 'uploads' && status !== 'ready') {
            const result = await this.attachments.prepareUploads(
              batch.conversationId,
              [
                {
                  id: row.attachmentId,
                  name: data.name,
                  mediaType: data.mediaType,
                  size: data.size,
                  sha256: data.sha256,
                },
              ],
              this.signer(),
            );
            if (result[0].upload) uploads.push({ kind: 'original', ...result[0].upload });
          }
          const part = this.part(row.attachmentId);
          if (input.view === 'uploads' && part && !part.cleaned && !parsed)
            uploads.push({
              kind: 'pdf-text',
              ...(await this.signer()(
                part.key,
                'application/vnd.everchat.pdf-text',
                part.expiresAt,
              )),
            });
        } catch (e) {
          if (e instanceof McpError) throw e;
          error = mcpAttachmentFailure(e).message;
          inputStatus = 'failed';
        }
      }
      const value = {
        clientFileId: data.clientFileId,
        attachmentRef,
        documentRef: encodeRef('document1', [batch.conversationId, data.documentId]),
        versionRef: encodeRef('version1', [batch.conversationId, row.attachmentId]),
        supersedes: data.supersedes,
        versionNote: data.versionNote ?? null,
        createdAt: data.createdAt,
        name: data.name,
        mediaType: data.mediaType,
        size: data.size,
        sha256: data.sha256,
        purpose: data.purpose,
        uploadStatus: status,
        inputStatus,
        error,
        parsed: parsed ? { ...parsed } : null,
        uploads,
      };
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (base.files.length && pageBytes + bytes > 23 * 1024) break;
      if (bytes > 24 * 1024)
        fail(
          'RECORD_TOO_LARGE',
          'This file metadata exceeds the response byte budget.',
          'retrieval',
        );
      base.files.push(value);
      pageBytes += bytes;
      nextOffset = row.ordinal + 1;
    }
    this.authorize(principal);
    this.batch(principal, base.uploadRef!);
    base.hasMore = !selected && rows.length > base.files.length;
    base.nextCursor = base.hasMore ? cursor(nextOffset) : null;
    return base;
  }
  async resolve(principal: string, input: ChatArguments): Promise<ResolvedAttachments | undefined> {
    const selections = input.attachments ?? [];
    if (!input.uploadRef && !selections.length) return undefined;
    const parent = this.parent(principal, input.continuation),
      batch = input.uploadRef ? this.batch(principal, input.uploadRef) : null;
    if (batch && batch.continuation !== (input.continuation ?? null))
      fail('UPLOAD_TARGET_MISMATCH', 'Use the same exact continuation as the upload batch.');
    const conversationId = parent?.conversationId ?? batch?.conversationId;
    if (!conversationId)
      fail('UPLOAD_TARGET_REQUIRED', 'A first attachment message requires uploadRef.');
    if (batch?.requestId && batch.requestId !== input.requestId)
      fail('UPLOAD_ALREADY_USED', 'This root upload batch is bound to another requestId.');
    if (new Set(selections.map((s) => s.attachmentRef)).size !== selections.length)
      fail('INVALID_ARGUMENT', 'Attachment references must be unique.');
    const materialBindings: Record<string, MaterialBinding> = {};
    const images: ImagePart[] = [],
      files: DocumentPart[] = [];
    for (const selection of selections) {
      const owned = this.file(principal, selection.attachmentRef),
        id = owned.row.attachmentId;
      if (owned.batch.conversationId !== conversationId)
        fail(
          'ATTACHMENT_ACCESS_DENIED',
          'Files belong to a different conversation.',
          'authorization',
        );
      await this.attachments.receive(conversationId, id);
      this.file(principal, selection.attachmentRef);
      if (owned.data.purpose === 'image') {
        if (selection.selection || selection.mode !== 'reuse')
          fail(
            'INVALID_ARGUMENT',
            'Image inputs do not accept document selection or replacement mode.',
          );
        images.push(...this.attachments.images(conversationId, [id]));
        continue;
      }
      let parsed = this.attachments.documents.parsedReference(conversationId, id);
      if (!parsed) {
        let extraction: PDFExtraction | undefined;
        if (owned.data.mediaType === 'application/pdf') {
          const part = this.part(id);
          if (!part || part.cleaned || !this.bucket)
            fail('PDF_EXTRACTION_REQUIRED', 'Upload the PDF extraction before calling chat.');
          const object = await this.bucket.get(part.key);
          if (
            !object ||
            object.size !== part.size ||
            object.httpMetadata?.contentType !== 'application/vnd.everchat.pdf-text'
          ) {
            await object?.body.cancel();
            fail(
              'ATTACHMENT_NOT_READY',
              'The PDF extraction is not completely uploaded.',
              'attachments',
              true,
            );
          }
          const digest = createHash('sha256');
          extraction = await readPdfUpload(
            object.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  digest.update(chunk);
                  controller.enqueue(chunk);
                },
              }),
            ),
          );
          if (digest.digest('hex') !== part.sha256)
            fail('ATTACHMENT_INVALID', 'The PDF extraction digest does not match.');
          this.file(principal, selection.attachmentRef);
        }
        parsed = await this.attachments.documents.parse(conversationId, id, extraction);
        this.file(principal, selection.attachmentRef);
      }
      let ranges: DocumentRange[] | undefined = selection.selection?.ranges;
      if (selection.selection?.pageRanges) {
        const archive = this.attachments.documents.archiveReference(conversationId, id);
        if (!archive?.pageOffsets) fail('PDF_PAGE_INDEX_REQUIRED', 'This PDF has no page index.');
        ranges = pageRanges(
          selection.selection.pageRanges.map((r) => `${r.start}-${r.end}`).join(','),
          archive.pageOffsets,
          parsed.characters,
        );
      }
      files.push(
        ranges ? await this.attachments.documents.select(conversationId, id, ranges) : parsed,
      );
      materialBindings[id] = {
        documentId: owned.data.documentId,
        versionId: id,
        mode: selection.mode,
        supersedes: owned.data.supersedes
          ? decodeRef('attachment1', owned.data.supersedes, 2)[1]
          : null,
      };
    }
    this.authorize(principal);
    for (const s of selections) this.file(principal, s.attachmentRef);
    return { conversationId, parentId: parent?.parentId ?? null, images, files, materialBindings };
  }
  bind(principal: string, input: ChatArguments) {
    if (!input.uploadRef) return;
    const batch = this.batch(principal, input.uploadRef);
    if (!input.continuation) {
      if (batch.requestId && batch.requestId !== input.requestId)
        fail('UPLOAD_ALREADY_USED', 'This upload batch is already used.');
      this.storage.sql.exec(
        'UPDATE mcp_uploads SET requestId=? WHERE principal=? AND uploadId=?',
        input.requestId,
        principal,
        batch.uploadId,
      );
    }
  }
  async delete(principal: string, refs: string[]) {
    const files = [];
    for (const attachmentRef of refs) {
      try {
        const { row, batch } = this.file(principal, attachmentRef, true);
        if (!row.deleted) {
          const result = await this.remove(batch.conversationId, row.attachmentId);
          if (result && typeof result === 'object' && 'error' in result)
            throw new HttpError(
              'status' in result ? Number(result.status) : 409,
              String(result.error),
              undefined,
              'issue' in result ? readErrorIssue(result.issue) : undefined,
            );
          this.authorize(principal);
          this.storage.sql.exec(
            'UPDATE mcp_upload_files SET deleted=1 WHERE attachmentId=?',
            row.attachmentId,
          );
        }
        files.push({ attachmentRef, deleted: true, error: null });
      } catch (e) {
        files.push({ attachmentRef, deleted: false, error: mcpAttachmentFailure(e) });
      }
    }
    return { files };
  }
  async response(principal: string, ref: string, head: boolean) {
    const { row, batch } = this.file(principal, ref),
      response = await this.attachments.response(batch.conversationId, row.attachmentId, head);
    try {
      this.file(principal, ref);
    } catch (e) {
      await response.body?.cancel();
      throw e;
    }
    return response;
  }
  async discussionFile(principal: string, ref: string) {
    const owned = this.file(principal, ref),
      saved = this.attachments.documents.parsedReference(
        owned.batch.conversationId,
        owned.row.attachmentId,
      );
    if (!saved)
      fail(
        'ATTACHMENT_NOT_READY',
        'Discussion background requires an already parsed text document.',
      );
    if (saved.characters > MAX_MESSAGE_TEXT_BYTES)
      fail(
        'DISCUSSION_TOO_LARGE',
        'This material exceeds a discussion background message; use a selected source message or a smaller file.',
      );
    let text = '',
      offset = 0;
    while (true) {
      const page = await this.attachments.documents.previewPage(
        owned.batch.conversationId,
        owned.row.attachmentId,
        offset,
      );
      this.file(principal, ref);
      if (page.state !== 'available')
        fail('CONTENT_UNAVAILABLE', 'The selected material text is unavailable.', 'retrieval');
      text += page.text;
      if (Buffer.byteLength(text) > MAX_MESSAGE_TEXT_BYTES)
        fail(
          'DISCUSSION_TOO_LARGE',
          'This material exceeds a discussion background message; choose a smaller file.',
        );
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    return {
      text,
      metadata: {
        documentRef: encodeRef('document1', [owned.batch.conversationId, owned.data.documentId]),
        versionRef: encodeRef('version1', [owned.batch.conversationId, owned.row.attachmentId]),
        name: saved.name,
        sha256: saved.sha256,
        textSha256: saved.textSha256,
        parserVersion: saved.pdf?.parserVersion ?? saved.version,
      },
    };
  }
  nextCleanup() {
    return this.storage.sql
      .exec<{ next: number }>(
        'SELECT MIN(lease) AS next FROM mcp_attachment_parts WHERE cleaned=0 HAVING COUNT(*)>0',
      )
      .toArray()[0]?.next;
  }
  async cleanup() {
    if (!this.bucket) return;
    const rows = this.storage.sql
      .exec<Part>(
        'SELECT * FROM mcp_attachment_parts WHERE cleaned=0 AND lease<=? ORDER BY lease LIMIT 4',
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.bucket.delete(row.key);
        this.storage.sql.exec(
          'DELETE FROM mcp_attachment_parts WHERE attachmentId=?',
          row.attachmentId,
        );
      } catch {
        this.storage.sql.exec(
          'UPDATE mcp_attachment_parts SET lease=? WHERE attachmentId=?',
          Date.now() + 30_000,
          row.attachmentId,
        );
      }
    }
  }
}
