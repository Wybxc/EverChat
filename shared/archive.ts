import * as v from 'valibot';
import { attachmentInputSchema, MAX_CONVERSATION_ATTACHMENTS, MAX_CONVERSATION_ATTACHMENT_BYTES } from './attachments';
import { MAX_BACKUP_BYTES, validateBackup, type EverChatBackup } from './backup';
import { documentPartSchema, MAX_DOCUMENT_BYTES } from './documents';
import { messageAttachments } from './message-content';
import { branchPath, type Message } from './types';
import { mergeProviderSettings } from './provider-settings';

export const ARCHIVE_FORMAT = 'everchat-archive', ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = MAX_BACKUP_BYTES + MAX_CONVERSATION_ATTACHMENT_BYTES + MAX_CONVERSATION_ATTACHMENTS * MAX_DOCUMENT_BYTES + 128 * 1024;
export const MAX_ARCHIVE_ENTRIES = 1 + MAX_CONVERSATION_ATTACHMENTS * 2;
export const ARCHIVE_MANIFEST = 'manifest.json';
export const originalPath = (id: string) => `files/${id}`;
export const extractedPath = (id: string) => `documents/${id}.txt`;
const fileSchema = v.strictObject({ ...attachmentInputSchema.entries,
  parsed: v.optional(v.strictObject({ reference: documentPartSchema,
    bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DOCUMENT_BYTES)) })),
});
export type ArchiveFile = v.InferOutput<typeof fileSchema>;
export interface ArchiveManifest { format: typeof ARCHIVE_FORMAT; version: typeof ARCHIVE_VERSION; backup: EverChatBackup; files: ArchiveFile[] }

export function validateArchiveManifest(value: unknown): ArchiveManifest {
  if (!value || typeof value !== 'object') throw new Error('备份清单无效。');
  const input = value as Record<string, unknown>;
  if (input.format !== ARCHIVE_FORMAT || input.version !== ARCHIVE_VERSION) throw new Error('备份存档版本不受支持。');
  const backup = validateBackup(input.backup), parsed = v.safeParse(v.array(fileSchema), input.files);
  const settings = { ...backup.settings, activeProviderId: null, activeModel: '' };
  mergeProviderSettings(settings, settings, { restoreModelMetadata: true });
  const messageIds = new Set(backup.conversation.messages.map((message) => message.id));
  if (messageIds.size !== backup.conversation.messages.length) throw new Error('备份中存在重复消息 ID。');
  for (const message of backup.conversation.messages) {
    if (message.parentId && !messageIds.has(message.parentId) || message.revisionOf && (!messageIds.has(message.revisionOf) || message.revisionOf === message.id)) throw new Error('备份中的消息关系不完整。');
    try { branchPath(backup.conversation.messages as unknown as Message[], message.id); } catch { throw new Error('备份中的消息父链无效。'); }
  }
  if (!parsed.success || parsed.output.length > MAX_CONVERSATION_ATTACHMENTS) throw new Error('备份中的文件列表无效。');
  const files = parsed.output, ids = new Set(files.map((file) => file.id));
  if (ids.size !== files.length || files.reduce((sum, file) => sum + file.size, 0) > MAX_CONVERSATION_ATTACHMENT_BYTES) throw new Error('备份中的文件重复或超出容量。');
  for (const file of files) if (file.parsed) {
    const ref = file.parsed.reference;
    if (ref.attachmentId !== file.id || ['name', 'mediaType', 'size', 'sha256'].some((field) => ref[field as keyof typeof ref] !== file[field as keyof ArchiveFile])) throw new Error('备份中的解析文件引用不符。');
  }
  for (const message of backup.conversation.messages) for (const reference of messageAttachments(message)) {
    const file = files.find((item) => item.id === reference.attachmentId);
    if (!file || ['name', 'mediaType', 'size', 'sha256'].some((field) => reference[field as keyof typeof reference] !== file[field as keyof ArchiveFile])
      || reference.type === 'file' && JSON.stringify(reference) !== JSON.stringify(file.parsed?.reference)) throw new Error('备份缺少消息引用的原文件或解析资料。');
  }
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, backup, files };
}

export function archiveEntries(manifest: ArchiveManifest) {
  return [ARCHIVE_MANIFEST, ...manifest.files.flatMap((file) => [originalPath(file.id), ...(file.parsed ? [extractedPath(file.id)] : [])])];
}

export const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
