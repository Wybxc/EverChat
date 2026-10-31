import * as v from 'valibot';
import { documentPartSchema, documentSource } from '../attachments/documents';
import { attachmentInputSchema, MAX_ATTACHMENT_BYTES } from '../attachments/files';
import { pdfExtractionSchema } from '../attachments/pdf';
import { branchPath } from '../conversation/branch-path';
import { messageAttachments } from '../conversation/content';
import { type Message } from '../conversation/types';
import { AppError, problem } from '../errors/descriptor';
import { mergeProviderSettings } from '../providers/settings';
import { MAX_BACKUP_BYTES, validateBackup, type EverChatBackup } from './backup';

export const ARCHIVE_FORMAT = 'everchat-archive',
  ARCHIVE_VERSION = 1;
// fflate uses classic ZIP: 32-bit offsets/sizes and 16-bit entry counts, not ZIP64.
export const MAX_ARCHIVE_BYTES = 0xffffffff;
export const MAX_ARCHIVE_ENTRIES = 0xffff;
export const ARCHIVE_MANIFEST = 'manifest.json';
export const originalPath = (id: string) => `files/${id}`;
export const extractedPath = (id: string) => `documents/${id}.txt`;
const fileSchema = v.strictObject({
  ...attachmentInputSchema.entries,
  parsed: v.optional(
    v.strictObject({
      reference: documentPartSchema,
      bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ATTACHMENT_BYTES)),
      pageOffsets: pdfExtractionSchema.entries.pageOffsets,
    }),
  ),
});
export type ArchiveFile = v.InferOutput<typeof fileSchema>;
export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  backup: EverChatBackup;
  files: ArchiveFile[];
}

export function validateArchiveManifest(value: unknown): ArchiveManifest {
  if (!value || typeof value !== 'object')
    throw new AppError(problem('BACKUP_INVALID'), '备份清单无效。');
  const input = value as Record<string, unknown>;
  if (input.format !== ARCHIVE_FORMAT || input.version !== ARCHIVE_VERSION)
    throw new AppError(problem('BACKUP_INVALID'), '备份存档版本不受支持。');
  const backup = validateBackup(input.backup),
    parsed = v.safeParse(v.array(fileSchema), input.files);
  const settings = { ...backup.settings, activeProviderId: null, activeModel: '' };
  mergeProviderSettings(settings, settings, { restoreModelMetadata: true });
  const messageIds = new Set(backup.conversation.messages.map((message) => message.id));
  if (messageIds.size !== backup.conversation.messages.length)
    throw new AppError(problem('BACKUP_INVALID'), '备份中存在重复消息 ID。');
  for (const message of backup.conversation.messages) {
    if (
      (message.parentId && !messageIds.has(message.parentId)) ||
      (message.revisionOf &&
        (!messageIds.has(message.revisionOf) || message.revisionOf === message.id))
    )
      throw new AppError(problem('BACKUP_INVALID'), '备份中的消息关系不完整。');
    try {
      branchPath(backup.conversation.messages as unknown as Message[], message.id);
    } catch {
      throw new AppError(problem('BACKUP_INVALID'), '备份中的消息父链无效。');
    }
  }
  if (!parsed.success) throw new AppError(problem('BACKUP_INVALID'), '备份中的文件列表无效。');
  const files = parsed.output,
    ids = new Set(files.map((file) => file.id));
  if (ids.size !== files.length)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的文件重复。');
  for (const file of files)
    if (file.parsed) {
      const ref = file.parsed.reference;
      if (
        ref.selection ||
        (ref.mediaType !== 'application/pdf' && file.parsed.pageOffsets) ||
        ref.attachmentId !== file.id ||
        ['name', 'mediaType', 'size', 'sha256'].some(
          (field) => ref[field as keyof typeof ref] !== file[field as keyof ArchiveFile],
        )
      )
        throw new AppError(problem('BACKUP_INVALID'), '备份中的解析文件引用不符。');
    }
  for (const message of backup.conversation.messages)
    for (const reference of messageAttachments(message)) {
      const file = files.find((item) => item.id === reference.attachmentId);
      if (
        !file ||
        ['name', 'mediaType', 'size', 'sha256'].some(
          (field) =>
            reference[field as keyof typeof reference] !== file[field as keyof ArchiveFile],
        ) ||
        (reference.type === 'file' &&
          JSON.stringify(documentSource(reference)) !== JSON.stringify(file.parsed?.reference))
      )
        throw new AppError(problem('BACKUP_INVALID'), '备份缺少消息引用的原文件或解析资料。');
    }
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, backup, files };
}

export function archiveEntries(manifest: ArchiveManifest) {
  return [
    ARCHIVE_MANIFEST,
    ...manifest.files.flatMap((file) => [
      originalPath(file.id),
      ...(file.parsed ? [extractedPath(file.id)] : []),
    ]),
  ];
}

export const sha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
