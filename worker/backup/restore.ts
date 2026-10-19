import { sha256, type ArchiveManifest } from '../../shared/backup/archive';
import { messageAttachments, messageFiles, messageImages } from '../../shared/conversation/content';
import { issueOf, problem, type ErrorIssue } from '../../shared/errors/descriptor';
import { AttachmentStore } from '../attachments/store';
import { CopyJobs } from '../backup/copies';
import { ArchiveImports, readArchiveManifest, type ImportResult } from '../backup/imports';
import type { Env } from '../http/env';
import { HttpError } from '../http/response';
import type { Library } from '../library/durable-object';
import { MAX_CONVERSATIONS } from '../platform/resource-limits';
import { ProviderSettingsStore } from '../providers/store';

// The Library owns transaction boundaries, its alarm and all feature stores.
export class ArchiveRestorer {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly imports: ArchiveImports,
    private readonly attachments: AttachmentStore,
    private readonly copies: CopyJobs,
    private readonly providers: ProviderSettingsStore,
    private readonly library: Pick<Library, 'deletedAt' | 'beginDelete' | 'touch'>,
    private readonly exists: (id: string) => boolean,
    private readonly schedule: () => Promise<void>,
  ) {}
  private checkImport(id: string, status?: string) {
    const row = this.imports.require(id, status);
    if (!this.exists(id))
      throw new HttpError(410, '恢复目标对话已删除。', undefined, problem('BACKUP_INVALID'));
    return row;
  }

  private importFailure(error: unknown): { error: string; issue?: ErrorIssue; status: number } {
    return {
      error: error instanceof HttpError ? error.message : '恢复暂时无法完成，请重试查看结果。',
      issue: issueOf(error, 'IMPORT_FAILED'),
      status: error instanceof HttpError ? error.status : 503,
    };
  }

  async beginImport(id: string, body: ReadableStream<Uint8Array>): Promise<ImportResult> {
    try {
      const manifest = await readArchiveManifest(body),
        bytes = new TextEncoder().encode(JSON.stringify(manifest)),
        hash = await sha256(bytes);
      const existing = this.imports.get(id);
      if (existing) {
        if (existing.sha256 !== hash)
          throw new HttpError(
            409,
            '此恢复 ID 已绑定另一份存档。',
            undefined,
            problem('BACKUP_INVALID'),
          );
        if (this.library.deletedAt(id) && existing.status === 'completed')
          throw new HttpError(410, '此恢复副本已删除。', undefined, problem('BACKUP_INVALID'));
        return this.imports.active.get(id) ?? this.imports.result(id);
      }
      if (this.exists(id) || this.library.deletedAt(id) || this.copies.get(id))
        throw new HttpError(
          409,
          '目标对话 ID 已被使用。',
          undefined,
          problem('CONVERSATION_ID_CONFLICT'),
        );
      if (
        this.ctx.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')
          .one().count >= MAX_CONVERSATIONS
      )
        throw new HttpError(507, '空间对话容量已满。', undefined, problem('STORAGE_FULL'));
      this.ctx.storage.transactionSync(() => {
        this.imports.begin(id, hash, bytes.byteLength, manifest.files);
        this.ctx.storage.sql.exec(
          'INSERT INTO conversations VALUES (?, ?, ?, ?)',
          id,
          manifest.backup.conversation.title,
          Date.now(),
          Date.now(),
        );
        for (const { id: target, file } of this.imports.files(id))
          this.attachments.register(id, {
            id: target,
            name: file.name,
            size: file.size,
            mediaType: file.mediaType,
            sha256: file.sha256,
          });
        this.ctx.storage.sql.exec(
          "UPDATE attachments SET lease = ? WHERE conversationId = ? AND status = 'registered'",
          this.imports.get(id)!.lease,
          id,
        );
      });
      const promise = this.prepareImport(id, bytes, manifest).finally(async () => {
        this.imports.active.delete(id);
        await this.schedule();
      });
      this.imports.active.set(id, promise);
      this.ctx.waitUntil(promise);
      return await promise;
    } catch (error) {
      return this.importFailure(error);
    }
  }

  private async prepareImport(
    id: string,
    bytes: Uint8Array,
    manifest: ArchiveManifest,
  ): Promise<ImportResult> {
    try {
      await this.ctx.storage.sync();
      await this.schedule();
      this.checkImport(id, 'preparing');
      if (manifest.files.length) {
        await this.imports.save(id, bytes);
        this.checkImport(id, 'uploading');
        return this.imports.result(id);
      }
      this.imports.prepareEmpty(id);
      this.imports.finalize(id);
      return await this.restoreImport(id, manifest);
    } catch (error) {
      return this.stopImport(id, error);
    }
  }

  private async stopImport(id: string, error: unknown): Promise<ImportResult> {
    if (this.imports.get(id)?.status === 'completed') return this.imports.result(id);
    const failure = this.importFailure(error);
    this.imports.fail(
      id,
      new HttpError(failure.status, failure.error, undefined, problem('BACKUP_INVALID')),
    );
    await this.library.beginDelete(id);
    await this.schedule();
    return this.imports.result(id);
  }

  importStatus(id: string) {
    if (this.library.deletedAt(id) && this.imports.get(id)?.status === 'completed')
      return { error: '此恢复副本已删除。', issue: problem('BACKUP_INVALID'), status: 410 };
    return this.imports.result(id);
  }

  importStopped(id: string) {
    return this.imports.get(id)?.status === 'failed';
  }

  async uploadImportFile(
    id: string,
    sourceId: string,
    body: ReadableStream<Uint8Array>,
    extracted: boolean,
  ) {
    try {
      this.checkImport(id, 'uploading');
      const mapped = this.imports.files(id).find((file) => file.sourceId === sourceId);
      if (!mapped) {
        await body.cancel();
        throw new HttpError(404, '找不到存档中的文件。', undefined, problem('NOT_FOUND'));
      }
      if (!extracted) {
        const result = await this.attachments.upload(id, mapped.id, body);
        this.checkImport(id, 'uploading');
        return { value: result };
      }
      if (!mapped.file.parsed) {
        await body.cancel();
        throw new HttpError(400, '此原文件没有提取文本。', undefined, problem('BACKUP_INVALID'));
      }
      const reference = mapped.file.parsed.reference;
      const bytes = await this.readImportText(body, mapped.file.parsed.bytes);
      if ((await sha256(bytes)) !== reference.textSha256)
        throw new HttpError(409, '提取文本的校验和不符。', undefined, problem('BACKUP_INVALID'));
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      this.checkImport(id, 'uploading');
      const result = await this.attachments.documents.parse(
        id,
        mapped.id,
        reference.pdf
          ? {
              text,
              pdf: reference.pdf,
              sourceSha256: mapped.file.sha256,
              pageOffsets: mapped.file.parsed.pageOffsets,
            }
          : undefined,
      );
      this.checkImport(id, 'uploading');
      if (JSON.stringify({ ...result, attachmentId: sourceId }) !== JSON.stringify(reference))
        throw new HttpError(
          409,
          '恢复后的解析资料与备份不符。',
          undefined,
          problem('BACKUP_INVALID'),
        );
      return { value: result };
    } catch (error) {
      await body.cancel().catch(() => {});
      const mapped = this.imports.files(id).find((file) => file.sourceId === sourceId);
      if (
        (error instanceof HttpError && [429, 507, 410].includes(error.status)) ||
        (mapped &&
          (this.attachments.unconfirmed(mapped.id) ||
            this.attachments.documents.unconfirmed(mapped.id)))
      ) {
        await this.stopImport(id, error);
      }
      const stopped = this.imports.get(id);
      return stopped?.status === 'failed'
        ? { error: stopped.error ?? '恢复已停止。', status: stopped.errorStatus ?? 409 }
        : this.importFailure(error);
    } finally {
      await this.schedule();
    }
  }

  private async readImportText(body: ReadableStream<Uint8Array>, expected: number) {
    const reader = body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      void reader.cancel().catch(() => {});
    }, 90_000);
    try {
      while (true) {
        const next = await reader.read();
        if (expired)
          throw new HttpError(408, '提取文本上传超时。', undefined, problem('REQUEST_TIMEOUT'));
        if (next.done) break;
        size += next.value.byteLength;
        if (size > expected)
          throw new HttpError(413, '提取文本过长。', undefined, problem('BACKUP_INVALID'));
        chunks.push(next.value);
      }
      if (size !== expected)
        throw new HttpError(400, '提取文本不完整。', undefined, problem('BACKUP_INVALID'));
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }

  async finishImport(id: string): Promise<ImportResult> {
    try {
      const current = this.imports.get(id);
      if (!current || ['failed', 'completed'].includes(current.status))
        return this.importStatus(id);
      const active = this.imports.active.get(id);
      if (active) return await active;
      this.checkImport(id, 'uploading');
      for (const { id: fileId, file } of this.imports.files(id)) {
        if (
          !this.attachments.list(id).some((item) => item.id === fileId && item.status === 'ready')
        )
          throw new HttpError(
            409,
            '仍有原文件尚未保存完成。',
            undefined,
            problem('BACKUP_INVALID'),
          );
        if (file.parsed && !this.attachments.documents.parsedReference(id, fileId))
          throw new HttpError(
            409,
            '仍有提取文本尚未保存完成。',
            undefined,
            problem('BACKUP_INVALID'),
          );
      }
      this.imports.finalize(id);
      const promise = this.restoreImport(id).finally(async () => {
        this.imports.active.delete(id);
        await this.schedule();
      });
      this.imports.active.set(id, promise);
      this.ctx.waitUntil(promise);
      return await promise;
    } catch (error) {
      return this.importFailure(error);
    }
  }

  private async restoreImport(id: string, saved?: ArchiveManifest): Promise<ImportResult> {
    try {
      await this.ctx.storage.sync();
      await this.schedule();
      this.checkImport(id, 'finalizing');
      const manifest = saved ?? (await this.imports.manifest(id));
      this.checkImport(id, 'finalizing');
      const mapped = new Map(this.imports.files(id).map((file) => [file.sourceId, file.id]));
      const messages = manifest.backup.conversation.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'image' || part.type === 'file'
            ? { ...part, attachmentId: mapped.get(part.attachmentId)! }
            : part,
        ),
      }));
      for (const { id: fileId, file } of this.imports.files(id)) {
        const response = await this.attachments.response(id, fileId, true);
        await response.body?.cancel();
        this.checkImport(id, 'finalizing');
        if (file.parsed) {
          const text = await this.attachments.documents.read(id, fileId);
          this.checkImport(id, 'finalizing');
          if (
            JSON.stringify({ ...text.file, attachmentId: file.id }) !==
            JSON.stringify(file.parsed.reference)
          )
            throw new HttpError(
              409,
              '恢复后的解析引用不符。',
              undefined,
              problem('BACKUP_INVALID'),
            );
        }
      }
      if (messages.some((message) => messageAttachments(message).length)) {
        await this.attachments.pinAttachments(
          id,
          messages.flatMap(messageImages),
          messages.flatMap(messageFiles),
        );
        this.checkImport(id, 'finalizing');
      }
      const result = await this.env.CONVERSATIONS.getByName(id).restoreResponse(
        id,
        new Response(JSON.stringify({ ...manifest.backup.conversation, messages })).body!,
      );
      this.checkImport(id, 'finalizing');
      if (!result.ok) {
        const failure = (await result.json()) as { error: string };
        throw new HttpError(result.status, failure.error, undefined, problem('BACKUP_INVALID'));
      }
      await result.body?.cancel();
      this.ctx.storage.transactionSync(() => {
        this.checkImport(id, 'finalizing');
        const prior = this.providers.providerSettingsData();
        const providers = manifest.backup.settings.providers.map((profile) => {
          const existing = prior.providers.find((saved) => saved.id === profile.id);
          return {
            ...profile,
            ...(existing &&
            (existing.provider !== profile.provider || existing.baseUrl !== profile.baseUrl)
              ? { apiKey: '' }
              : {}),
          };
        });
        const settings = this.providers.saveProviderSettings(
          { ...manifest.backup.settings, providers, activeProviderId: null, activeModel: '' },
          manifest.backup.settings.promptPresets,
          { restoreModelMetadata: true, preserveKeysAcrossConnections: false },
        );
        if ('error' in settings)
          throw new HttpError(
            settings.status ?? 400,
            settings.error,
            undefined,
            problem('BACKUP_INVALID'),
          );
        this.imports.complete(id);
        this.library.touch(id);
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO search_backfill(conversationId) VALUES (?)',
          id,
        );
      });
      await this.ctx.storage.sync();
      return this.imports.result(id);
    } catch (error) {
      return this.stopImport(id, error);
    }
  }

  async cancelImport(id: string) {
    const row = this.imports.get(id);
    if (!row) return { error: '找不到这项恢复。', issue: problem('NOT_FOUND'), status: 404 };
    if (row.status === 'completed')
      return { error: '恢复已完成。', issue: problem('BACKUP_INVALID'), status: 409 };
    this.imports.fail(id, new HttpError(409, '恢复已取消。', undefined, problem('BACKUP_INVALID')));
    await this.library.beginDelete(id);
    return { value: true };
  }
}
