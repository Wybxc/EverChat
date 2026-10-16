import { DurableObject } from 'cloudflare:workers';
import type { DocumentPart } from '../../shared/attachments/documents';
import type { AttachmentInput } from '../../shared/attachments/files';
import type { ImagePart } from '../../shared/attachments/images';
import type { PDFExtraction } from '../../shared/attachments/pdf';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  validateArchiveManifest,
} from '../../shared/backup/archive';
import type { BackupMessage } from '../../shared/backup/backup';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  type BackupSettings,
} from '../../shared/backup/backup';
import { messageAttachments, messageFiles, messageImages } from '../../shared/conversation/content';
import type { ConversationInfo, ConversationSettings } from '../../shared/conversation/types';
import type { ModelSelection, ReasoningEffort } from '../../shared/models/types';
import type { PromptPreset, PromptPresetInput } from '../../shared/presets/types';
import type {
  ProviderConfig,
  ProviderModelConfig,
  ProviderSettings,
  ProviderSettingsInput,
} from '../../shared/providers/types';
import type { SearchDocument } from '../../shared/search/query';
import type { Snapshot } from '../../shared/streaming/protocol';
import { AttachmentStore } from '../attachments/store';
import { CopyJobs, type CopyResult } from '../backup/copies';
import { ArchiveImports, type ImportResult } from '../backup/imports';
import { ArchiveRestorer } from '../backup/restore';
import type { Env } from '../http/env';
import { HttpError, json } from '../http/response';
import { MAX_CONVERSATIONS } from '../platform/resource-limits';
import { PromptPresetError, PromptPresets } from '../presets/store';
import { ProviderSettingsStore } from '../providers/store';
import {
  SEARCH_CAPACITY_MESSAGE,
  SearchChanged,
  SearchIndex,
  searchRetryDelay,
} from '../search/index';
import { WebToolSettings } from '../web-tools/settings';
import type { ConversationActivity } from '../../shared/conversation/activity';
import { LIBRARY_ACTIVITY_SCHEMA, LibraryActivityIndex } from './activity';

type Deletion = { id: string; deletedAt: number; completed: number } & Record<
  string,
  SqlStorageValue
>;
const conversationSelect = `SELECT conversations.*, COALESCE(metadata.pinned, 0) AS pinned, COALESCE(metadata.archived, 0) AS archived
  FROM conversations LEFT JOIN conversation_metadata AS metadata ON metadata.id = conversations.id
  WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = conversations.id)
  AND NOT EXISTS (SELECT 1 FROM conversation_copies WHERE conversation_copies.id = conversations.id AND conversation_copies.status != 'completed')
  AND NOT EXISTS (SELECT 1 FROM archive_imports WHERE archive_imports.id = conversations.id AND archive_imports.status != 'completed')`;
const decorate = (row: Record<string, SqlStorageValue>) =>
  ({
    ...row,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
  }) as unknown as ConversationInfo;

export class Library extends DurableObject<Env> {
  private readonly restorer: ArchiveRestorer;
  private readonly providers: ProviderSettingsStore;
  private readonly searchIndex: SearchIndex;
  private readonly presets: PromptPresets;
  private readonly attachments: AttachmentStore;
  private readonly copies: CopyJobs;
  private readonly imports: ArchiveImports;
  private readonly webTools: WebToolSettings;
  private readonly activity: LibraryActivityIndex;
  private readonly interruptedImportFiles = new Set<string>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.webTools = new WebToolSettings(
      <T extends Record<string, SqlStorageValue>>(
        statement: string,
        ...bindings: SqlStorageValue[]
      ) => ctx.storage.sql.exec<T>(statement, ...bindings),
    );
    this.presets = new PromptPresets(ctx.storage);
    this.copies = new CopyJobs(ctx.storage);
    this.imports = new ArchiveImports(ctx.storage, env.ATTACHMENTS);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS conversation_metadata (id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS conversation_deletions (id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0)',
    );
    ctx.storage.sql.exec(LIBRARY_ACTIVITY_SCHEMA);
    this.activity = new LibraryActivityIndex(
      <T extends Record<string, SqlStorageValue>>(
        statement: string,
        ...bindings: SqlStorageValue[]
      ) => ctx.storage.sql.exec<T>(statement, ...bindings),
    );
    this.providers = new ProviderSettingsStore(ctx.storage, env, this.presets);
    this.searchIndex = new SearchIndex(ctx.storage);
    this.attachments = new AttachmentStore(ctx.storage, env.ATTACHMENTS, (id) =>
      Boolean(this.internalConversation(id)),
    );
    this.restorer = new ArchiveRestorer(
      ctx,
      env,
      this.imports,
      this.attachments,
      this.copies,
      this.providers,
      this,
      (id) => Boolean(this.internalConversation(id)),
      () => this.scheduleMaintenance(),
    );
    for (const row of ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT files.id FROM archive_import_files AS files JOIN attachments ON attachments.id = files.id
      LEFT JOIN attachment_documents AS documents ON documents.id = files.id
      WHERE attachments.status IN ('uploading', 'failed') OR documents.status IN ('parsing', 'cleaning', 'failed')`,
      )
      .toArray())
      this.interruptedImportFiles.add(row.id);
    // Feature initialization reads existing messages in bounded pages, never on a search request.
    ctx.storage.sql
      .exec(`INSERT OR IGNORE INTO search_backfill(conversationId) SELECT id FROM conversations
      WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = conversations.id)
      AND NOT EXISTS (SELECT 1 FROM conversation_copies WHERE conversation_copies.id = conversations.id AND conversation_copies.status != 'completed')
      AND NOT EXISTS (SELECT 1 FROM archive_imports WHERE archive_imports.id = conversations.id AND archive_imports.status != 'completed')`);
    ctx.waitUntil(this.scheduleMaintenance());
  }
  private async scheduleMaintenance() {
    await this.ctx.storage.transaction(async () => {
      const sql = this.ctx.storage.sql;
      const pending = sql
        .exec<{ nextAt: number }>(
          'SELECT MIN(nextAt) AS nextAt FROM search_backfill WHERE done = 0 HAVING COUNT(*) > 0',
        )
        .toArray()[0];
      const cleanup = this.attachments.nextCleanup();
      const copy = Math.min(this.copies.nextMaintenance(), this.nextImportMaintenance());
      if (!pending && cleanup === undefined && !Number.isFinite(copy)) return;
      const alarm = await this.ctx.storage.getAlarm();
      const next = Math.max(
        Date.now() + 1000,
        Math.min(pending?.nextAt ?? Infinity, cleanup ?? Infinity, copy),
      );
      if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
    });
  }
  private nextImportMaintenance() {
    const interrupted = this.imports
      .pending()
      .some(
        (job) =>
          job.status === 'uploading' &&
          this.imports.files(job.id).some((file) => this.interruptedImportFiles.has(file.id)),
      );
    return Math.min(this.imports.nextMaintenance(), interrupted ? Date.now() + 1000 : Infinity);
  }
  applySearchDocuments(id: string, documents: SearchDocument[]) {
    if (!this.get(id)) return;
    try {
      this.searchIndex.replace(id, documents);
      this.ctx.storage.sql.exec('DELETE FROM search_problems WHERE conversationId = ?', id);
    } catch (error) {
      this.ctx.storage.sql.exec(
        'INSERT INTO search_problems VALUES (?, ?) ON CONFLICT(conversationId) DO UPDATE SET error = excluded.error',
        id,
        error instanceof Error && error.message === SEARCH_CAPACITY_MESSAGE
          ? SEARCH_CAPACITY_MESSAGE
          : '部分对话的索引尚未更新，请稍后重试。',
      );
      throw error;
    }
  }
  search(query: string, archived: boolean, cursor?: string) {
    try {
      return this.searchIndex.search(query, archived, cursor);
    } catch (error) {
      if (error instanceof SearchChanged) return { error: error.message, status: 409 };
      throw error;
    }
  }
  list(): ConversationInfo[] {
    return this.ctx.storage.sql
      .exec(`${conversationSelect} ORDER BY pinned DESC, updatedAt DESC, conversations.id`)
      .toArray()
      .map(decorate);
  }
  indexSnapshot(after: number) {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; id: string; deletedAt: number }>(
        'SELECT rowid AS seq, id, deletedAt FROM conversation_deletions WHERE rowid > ? ORDER BY rowid LIMIT 257',
        after,
      )
      .toArray();
    const page = rows.slice(0, 256);
    return {
      conversations: this.list(),
      activity: this.activity.snapshot(),
      deletions: page.map(({ id, deletedAt }) => ({ id, deletedAt })),
      deletionCursor: page.at(-1)?.seq ?? after,
      hasMoreDeletions: rows.length > 256,
    };
  }
  reportActivity(id: string, activity: ConversationActivity) {
    this.activity.accept(id, activity);
  }
  get(id: string): ConversationInfo | null {
    const row = this.ctx.storage.sql
      .exec(`${conversationSelect} AND conversations.id = ?`, id)
      .toArray()[0];
    return row ? decorate(row) : null;
  }
  private internalConversation(id: string) {
    return this.ctx.storage.sql
      .exec(
        'SELECT id FROM conversations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM conversation_deletions WHERE conversation_deletions.id = conversations.id)',
        id,
      )
      .toArray()[0];
  }
  deletedAt(id: string): number | null {
    return (
      this.ctx.storage.sql
        .exec<Deletion>('SELECT * FROM conversation_deletions WHERE id = ?', id)
        .toArray()[0]?.deletedAt ?? null
    );
  }
  create(id: string, title: string) {
    if (this.deletedAt(id)) return { error: '这个对话已删除。', status: 410 };
    if (this.copies.get(id)?.status !== undefined && this.copies.get(id)?.status !== 'completed')
      return { error: '此对话正在复制或已停止。', status: 409 };
    if (this.imports.get(id)?.status !== undefined && this.imports.get(id)?.status !== 'completed')
      return { error: '此对话正在恢复或已停止。', status: 409 };
    const existing = this.get(id);
    if (existing) return existing;
    if (
      this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')
        .one().count >= MAX_CONVERSATIONS
    ) {
      return {
        error: `空间最多保存 ${MAX_CONVERSATIONS} 个对话，请整理已有对话后再创建。`,
        status: 507,
      };
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO conversations VALUES (?, ?, ?, ?)',
      id,
      title,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO search_backfill(conversationId) VALUES (?)',
      id,
    );
    this.ctx.waitUntil(this.scheduleMaintenance());
    return this.get(id)!;
  }
  touch(id: string) {
    if (!this.deletedAt(id))
      this.ctx.storage.sql.exec(
        'UPDATE conversations SET updatedAt = ? WHERE id = ?',
        Date.now(),
        id,
      );
  }
  update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    if (this.deletedAt(id)) return { error: '这个对话已删除。', status: 410 };
    const current = this.get(id);
    if (!current) return { error: '找不到这个对话。', status: 404 };
    this.ctx.storage.transactionSync(() => {
      if (patch.title !== undefined)
        this.ctx.storage.sql.exec(
          'UPDATE conversations SET title = ? WHERE id = ?',
          patch.title,
          id,
        );
      if (patch.pinned !== undefined || patch.archived !== undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO conversation_metadata VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pinned = excluded.pinned, archived = excluded.archived`,
          id,
          Number(patch.pinned ?? current.pinned),
          Number(patch.archived ?? current.archived),
        );
      }
      this.searchIndex.changed();
    });
    return this.get(id)!;
  }
  async beginDelete(id: string) {
    return this.ctx.storage.transaction(async () => {
      const existing = this.ctx.storage.sql
        .exec<Deletion>('SELECT * FROM conversation_deletions WHERE id = ?', id)
        .toArray()[0];
      if (existing?.completed) return existing;
      const deletion = existing ?? { id, deletedAt: Date.now(), completed: 0 };
      if (!existing)
        this.ctx.storage.sql.exec(
          'INSERT INTO conversation_deletions VALUES (?, ?, 0)',
          id,
          deletion.deletedAt,
        );
      for (const copy of this.copies.pending())
        if (copy.sourceId === id || copy.id === id) {
          this.copies.fail(copy.id, new HttpError(410, '复制来源或目标对话已删除。'));
          this.ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO conversation_deletions VALUES (?, ?, 0)',
            copy.id,
            deletion.deletedAt,
          );
          this.attachments.removeConversation(copy.id);
          this.searchIndex.remove(copy.id);
        }
      this.searchIndex.remove(id);
      this.imports.fail(id, new HttpError(410, '恢复目标对话已删除。'));
      this.attachments.removeConversation(id);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return deletion;
    });
  }
  completeDelete(id: string) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM conversations WHERE id = ?', id);
      this.ctx.storage.sql.exec('DELETE FROM conversation_metadata WHERE id = ?', id);
      this.ctx.storage.sql.exec('DELETE FROM conversation_activity WHERE id = ?', id);
      this.ctx.storage.sql.exec('UPDATE conversation_deletions SET completed = 1 WHERE id = ?', id);
    });
  }
  async alarm() {
    for (const job of this.imports.pending())
      if (
        job.status === 'uploading' &&
        this.imports.files(job.id).some((file) => this.interruptedImportFiles.has(file.id))
      ) {
        this.imports.fail(job.id, new HttpError(409, '恢复文件写入因实例中断而停止，请重新导入。'));
        await this.beginDelete(job.id);
      }
    for (const job of this.imports.pending())
      if (
        job.lease <= Date.now() ||
        (job.status !== 'uploading' && !this.imports.active.has(job.id))
      ) {
        this.imports.fail(
          job.id,
          new HttpError(
            job.lease <= Date.now() ? 408 : 409,
            job.lease <= Date.now()
              ? '恢复超过等待期限，请重新导入。'
              : '恢复因实例中断而停止，请重新导入。',
          ),
        );
        await this.beginDelete(job.id);
      }
    for (const copy of this.copies.pending())
      if (!this.copies.active.has(copy.id) || copy.lease <= Date.now()) {
        this.copies.fail(
          copy.id,
          new HttpError(
            copy.lease <= Date.now() ? 408 : 409,
            copy.lease <= Date.now()
              ? '复制超过 10 分钟，请重新尝试。'
              : '复制因实例中断而停止，请重新尝试。',
          ),
        );
        await this.beginDelete(copy.id);
      }
    await this.attachments.cleanup();
    await this.imports.cleanup();
    const pending = this.ctx.storage.sql
      .exec<Deletion>('SELECT * FROM conversation_deletions WHERE completed = 0 LIMIT 16')
      .toArray();
    let failed = false;
    for (const deletion of pending) {
      try {
        await this.env.CONVERSATIONS.getByName(deletion.id).deleteConversation(deletion.deletedAt);
        this.completeDelete(deletion.id);
      } catch {
        failed = true;
        console.warn('EverChat deletion cleanup will retry');
      }
    }
    const job = this.ctx.storage.sql
      .exec<{ conversationId: string; after: number; attempts: number }>(
        'SELECT conversationId, after, attempts FROM search_backfill WHERE done = 0 AND nextAt <= ? ORDER BY nextAt, conversationId LIMIT 1',
        Date.now(),
      )
      .toArray()[0];
    if (job) {
      try {
        const page = await this.env.CONVERSATIONS.getByName(job.conversationId).searchDocumentPage(
          job.after,
        );
        // Deletion may interleave while reading another object.
        if (this.get(job.conversationId)) {
          this.applySearchDocuments(job.conversationId, page.documents);
          this.ctx.storage.sql.exec(
            'UPDATE search_backfill SET after = ?, done = ?, attempts = 0, nextAt = 0 WHERE conversationId = ?',
            page.after,
            Number(page.done),
            job.conversationId,
          );
        }
      } catch {
        this.ctx.storage.sql.exec(
          'UPDATE search_backfill SET attempts = attempts + 1, nextAt = ? WHERE conversationId = ?',
          Date.now() + searchRetryDelay(job.attempts + 1),
          job.conversationId,
        );
        console.warn('EverChat search initialization will retry');
      }
    }
    await this.ctx.storage.transaction(async () => {
      const deletion = this.ctx.storage.sql
        .exec('SELECT id FROM conversation_deletions WHERE completed = 0 LIMIT 1')
        .toArray().length;
      const indexing = this.ctx.storage.sql
        .exec<{ nextAt: number }>(
          'SELECT MIN(nextAt) AS nextAt FROM search_backfill WHERE done = 0 HAVING COUNT(*) > 0',
        )
        .toArray()[0];
      const cleanup = this.attachments.nextCleanup();
      const next = Math.min(
        deletion ? Date.now() + (failed ? 30_000 : 1000) : Infinity,
        indexing ? Math.max(Date.now() + 1000, indexing.nextAt) : Infinity,
        cleanup === undefined ? Infinity : Math.max(Date.now() + 1000, cleanup),
        this.copies.nextMaintenance(),
        this.nextImportMaintenance(),
      );
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
      else await this.ctx.storage.deleteAlarm();
    });
  }
  async duplicate(
    sourceId: string,
    id: string,
    messageId?: string,
    viewHeadId?: string,
  ): Promise<CopyResult> {
    try {
      const existing = this.copies.get(id);
      if (existing) {
        if (
          existing.sourceId !== sourceId ||
          existing.messageId !== (messageId ?? null) ||
          existing.viewHeadId !== (viewHeadId ?? null)
        )
          throw new HttpError(409, '此复制请求已用于其他来源。');
        if (existing.status === 'completed') {
          if (!this.get(id)) throw new HttpError(410, '这个副本已删除。');
          return { id, viewHeadId: existing.copiedHeadId };
        }
        if (existing.status === 'failed')
          throw new HttpError(
            existing.errorStatus ?? 409,
            existing.error ?? '复制已停止，请重新尝试。',
          );
        const active = this.copies.active.get(id);
        if (active) return await active;
        this.copies.fail(id, new HttpError(409, '复制因实例中断而停止，请重新尝试。'));
        await this.beginDelete(id);
        throw new HttpError(409, '复制因实例中断而停止，请重新尝试。');
      }
      const source = this.get(sourceId);
      if (!source)
        throw new HttpError(this.deletedAt(sourceId) ? 410 : 404, '找不到复制来源对话。');
      if (this.internalConversation(id) || this.deletedAt(id))
        throw new HttpError(409, '目标对话 ID 已被使用。');
      if (
        this.ctx.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')
          .one().count >= MAX_CONVERSATIONS
      )
        throw new HttpError(
          507,
          `空间最多保存 ${MAX_CONVERSATIONS} 个对话，请整理已有对话后再创建。`,
        );
      this.ctx.storage.transactionSync(() => {
        this.copies.begin(id, sourceId, messageId, viewHeadId);
        const now = Date.now();
        this.ctx.storage.sql.exec(
          'INSERT INTO conversations VALUES (?, ?, ?, ?)',
          id,
          `${source.title} 副本`.slice(0, 80),
          now,
          now,
        );
      });
      const promise = this.performCopy(source, id, messageId, viewHeadId).finally(async () => {
        this.copies.active.delete(id);
        await this.scheduleMaintenance();
      });
      this.copies.active.set(id, promise);
      this.ctx.waitUntil(promise);
      return await promise;
    } catch (error) {
      return {
        error: error instanceof HttpError ? error.message : '复制暂时无法完成，请重新尝试。',
        status: error instanceof HttpError ? error.status : 503,
      };
    }
  }
  private async performCopy(
    source: ConversationInfo,
    id: string,
    messageId?: string,
    viewHeadId?: string,
  ): Promise<CopyResult> {
    const check = () => {
      this.copies.requireActive(id);
      if (!this.get(source.id) || !this.internalConversation(id))
        throw new HttpError(410, '复制来源或目标对话已删除。');
    };
    try {
      await this.ctx.storage.sync();
      await this.scheduleMaintenance();
      check();
      const response = await this.env.CONVERSATIONS.getByName(source.id).copySourceResponse(
        messageId,
      );
      check();
      if (!response.ok) {
        const failure = (await response.json()) as { error: string };
        throw new HttpError(response.status, failure.error);
      }
      const saved = (await response.json()) as {
        messages: BackupMessage[];
        settings: ConversationSettings;
      };
      check();
      const requestedHead = messageId ?? viewHeadId;
      const headPosition = requestedHead
        ? saved.messages.findIndex((message) => message.id === requestedHead && !message.summary)
        : -1;
      if (requestedHead && headPosition < 0) throw new HttpError(404, '找不到待复制的显示分支。');
      const images = saved.messages.flatMap(messageImages),
        files = saved.messages.flatMap(messageFiles);
      if (images.length || files.length) {
        await this.attachments.pinAttachments(source.id, images, files);
        check();
      }
      const required = new Set(
        saved.messages.flatMap(messageAttachments).map((file) => file.attachmentId),
      );
      const originals =
        this.env.ATTACHMENTS || this.attachments.hasSaved(source.id)
          ? this.attachments
              .list(source.id)
              .filter((file) => file.status === 'ready' && (!messageId || required.has(file.id)))
          : [];
      if ([...required].some((fileId) => !originals.some((file) => file.id === fileId)))
        throw new HttpError(409, '待复制附件不完整。');
      const mapped = new Map<string, string>();
      for (const file of originals) {
        check();
        const cloneId = crypto.randomUUID();
        await this.attachments.clone(source.id, id, file.id, cloneId);
        check();
        mapped.set(file.id, cloneId);
      }
      const messages = saved.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'image' || part.type === 'file'
            ? { ...part, attachmentId: mapped.get(part.attachmentId)! }
            : part,
        ),
      }));
      const copiedImages = messages.flatMap(messageImages),
        copiedFiles = messages.flatMap(messageFiles);
      if (copiedImages.length || copiedFiles.length) {
        await this.attachments.pinAttachments(id, copiedImages, copiedFiles);
        check();
      }
      const payload = JSON.stringify({
        id: source.id,
        title: source.title,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        messages,
        settings: saved.settings,
      });
      if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_BYTES)
        throw new HttpError(413, '复制资料超过 12 MiB，请选择较短的分支。');
      const restored = await this.env.CONVERSATIONS.getByName(id).restoreResponse(
        id,
        new Response(payload).body!,
      );
      check();
      if (!restored.ok) {
        const failure = (await restored.json()) as { error: string };
        throw new HttpError(restored.status, failure.error);
      }
      const copiedSnapshot = (await restored.json()) as Snapshot;
      const copiedHeadId =
        headPosition >= 0 ? (copiedSnapshot.messages[headPosition]?.id ?? null) : null;
      this.ctx.storage.transactionSync(() => {
        check();
        this.copies.complete(id, copiedHeadId);
        this.touch(id);
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO search_backfill(conversationId) VALUES (?)',
          id,
        );
      });
      await this.ctx.storage.sync();
      return { id, viewHeadId: copiedHeadId };
    } catch (error) {
      const stopped = this.copies.get(id);
      const failure =
        stopped?.status === 'failed'
          ? new HttpError(stopped.errorStatus ?? 409, stopped.error ?? '复制已停止。')
          : error instanceof HttpError
            ? error
            : new HttpError(503, '复制暂时无法完成，请重新尝试。');
      this.copies.fail(id, failure);
      await this.beginDelete(id);
      return { error: failure.message, status: failure.status };
    }
  }
  copyStopped(id: string) {
    return this.copies.get(id)?.status === 'failed';
  }
  async archiveManifestResponse(id: string, textOnly = false) {
    try {
      const conversation = this.get(id);
      if (!conversation) throw new HttpError(404, '找不到这个对话。');
      const source = await this.env.CONVERSATIONS.getByName(id).copySourceResponse();
      if (!source.ok) return source;
      const saved = (await source.json()) as {
        messages: BackupMessage[];
        settings: ConversationSettings;
      };
      if (!this.get(id)) throw new HttpError(410, '对话已删除。');
      const files =
        this.env.ATTACHMENTS || this.attachments.hasSaved(id)
          ? this.attachments.archiveFiles(id)
          : [];
      const manifest = validateArchiveManifest({
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        backup: {
          format: BACKUP_FORMAT,
          version: BACKUP_VERSION,
          exportedAt: Date.now(),
          conversation: { ...conversation, messages: saved.messages, settings: saved.settings },
          settings: this.backupSettings(),
        },
        files,
      });
      if (textOnly && files.length) throw new HttpError(409, '此对话包含文件，请下载 ZIP 备份。');
      const response = json(textOnly ? manifest.backup : manifest);
      if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > MAX_BACKUP_BYTES)
        throw new HttpError(413, '备份清单超过 12 MiB。');
      return response;
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : '备份清单无法读取。' },
        error instanceof HttpError ? error.status : 409,
      );
    }
  }
  async beginImport(id: string, body: ReadableStream<Uint8Array>): Promise<ImportResult> {
    return this.restorer.beginImport(id, body);
  }
  importStatus(id: string) {
    return this.restorer.importStatus(id);
  }
  importStopped(id: string) {
    return this.restorer.importStopped(id);
  }
  async uploadImportFile(
    id: string,
    sourceId: string,
    body: ReadableStream<Uint8Array>,
    extracted: boolean,
  ) {
    return this.restorer.uploadImportFile(id, sourceId, body, extracted);
  }
  async finishImport(id: string): Promise<ImportResult> {
    return this.restorer.finishImport(id);
  }
  async cancelImport(id: string) {
    return this.restorer.cancelImport(id);
  }
  providerConfig(selection?: ModelSelection, effort?: ReasoningEffort): ProviderConfig | null {
    return this.providers.providerConfig(selection, effort);
  }
  providerSettings(): ProviderSettings {
    return this.providers.providerSettings();
  }
  webToolSettings() {
    return this.webTools.settings();
  }
  webToolConfig() {
    return this.webTools.config();
  }
  webToolKey() {
    return this.webTools.key();
  }
  saveWebToolSettings(value: unknown) {
    return this.ctx.storage.transactionSync(() => this.webTools.save(value));
  }
  async claimWebToolRequest(id: string, acceptedLimit: number) {
    const result = this.ctx.storage.transactionSync(() => this.webTools.claim(id, acceptedLimit));
    await this.ctx.storage.sync();
    return result;
  }
  providerSettingsResponse() {
    return this.providers.providerSettingsResponse();
  }
  async saveProviderSettingsResponse(body: ReadableStream<Uint8Array>) {
    return this.providers.saveProviderSettingsResponse(body);
  }
  sessionSettings() {
    return this.providers.sessionSettings();
  }
  private async attachmentAction<T>(
    action: () => T | Promise<T>,
  ): Promise<{ value: T } | { error: string; status: number }> {
    try {
      return { value: await action() };
    } catch (error) {
      return {
        error: error instanceof HttpError ? error.message : '附件存储暂时不可用，请稍后重试。',
        status: error instanceof HttpError ? error.status : 503,
      };
    }
  }
  listAttachments(conversationId: string) {
    return this.attachmentAction(() => this.attachments.list(conversationId));
  }
  imageReferences(conversationId: string, ids: string[]) {
    return this.attachmentAction(() => this.attachments.images(conversationId, ids));
  }
  pinAttachments(conversationId: string, images: ImagePart[], files: DocumentPart[]) {
    return this.attachmentAction(() =>
      this.attachments.pinAttachments(conversationId, images, files),
    );
  }
  documentReferences(conversationId: string, ids: string[]) {
    return this.attachmentAction(() => this.attachments.documents.references(conversationId, ids));
  }
  async parseDocument(conversationId: string, id: string, input?: PDFExtraction) {
    const action = this.attachmentAction(() =>
      this.attachments.documents.parse(conversationId, id, input),
    );
    await this.scheduleMaintenance();
    try {
      return await action;
    } finally {
      await this.scheduleMaintenance();
    }
  }
  documentText(conversationId: string, id: string) {
    return this.attachmentAction(() => this.attachments.documents.read(conversationId, id));
  }
  async registerAttachment(conversationId: string, input: AttachmentInput) {
    const result = await this.attachmentAction(() =>
      this.attachments.register(conversationId, input),
    );
    await this.scheduleMaintenance();
    return result;
  }
  async uploadAttachment(conversationId: string, id: string, body: ReadableStream<Uint8Array>) {
    try {
      return await this.attachmentAction(() => this.attachments.upload(conversationId, id, body));
    } finally {
      await this.scheduleMaintenance();
    }
  }
  async attachmentResponse(conversationId: string, id: string, head: boolean) {
    const result = await this.attachmentAction(() =>
      this.attachments.response(conversationId, id, head),
    );
    return 'error' in result ? json({ error: result.error }, result.status) : result.value;
  }
  async removeAttachment(conversationId: string, id: string) {
    const result = await this.attachmentAction(async () => {
      const usage = this.attachments.usage(id);
      if (usage && (await this.env.CONVERSATIONS.getByName(conversationId).usesAttachment(id)))
        throw new HttpError(409, '文件仍被消息或生成任务使用，请先删除相关消息。');
      this.attachments.remove(conversationId, id, usage);
    });
    await this.scheduleMaintenance();
    return result;
  }
  promptPresets() {
    return this.presets.list();
  }
  savePromptPreset(id: string, input: PromptPresetInput) {
    try {
      return this.presets.save(id, input);
    } catch (error) {
      if (error instanceof PromptPresetError) return { error: error.message, status: error.status };
      throw error;
    }
  }
  deletePromptPreset(id: string) {
    return this.presets.remove(id);
  }
  backupSettings(): BackupSettings {
    return this.providers.backupSettings();
  }
  providerForModelList(id: string): ProviderModelConfig | null {
    return this.providers.providerForModelList(id);
  }
  saveProviderSettings(
    input: ProviderSettingsInput,
    importedPresets?: PromptPreset[],
    options: { restoreModelMetadata?: boolean; preserveKeysAcrossConnections?: boolean } = {},
  ): { settings: ProviderSettings } | { error: string; status?: number } {
    return this.providers.saveProviderSettings(input, importedPresets, options);
  }
}
