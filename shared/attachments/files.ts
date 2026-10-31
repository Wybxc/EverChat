import * as v from 'valibot';
import { MAX_HTTP_BODY_BYTES } from '../platform/limits';

export const MAX_ATTACHMENT_BYTES = MAX_HTTP_BODY_BYTES;
export const ATTACHMENT_UPLOAD_TIMEOUT = 60_000,
  ATTACHMENT_LEASE = 5 * 60_000;
export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/pdf',
] as const;
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/** Format hints select a pipeline; only the saved bytes establish valid text. */
export function normalizeAttachmentMediaType(value: string): AttachmentMediaType | null {
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  if (ATTACHMENT_MEDIA_TYPES.includes(mime as AttachmentMediaType))
    return mime as AttachmentMediaType;
  if (
    !mime ||
    mime === 'application/octet-stream' ||
    mime.startsWith('text/') ||
    mime === 'image/svg+xml' ||
    /^application\/[a-z0-9.!#$&^_+-]+$/.test(mime)
  )
    return 'text/plain';
  return null;
}
export const attachmentInputSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.check((name) => Boolean(name.trim()) && !/[\u0000-\u001f\u007f/\\]/.test(name)),
  ),
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ATTACHMENT_BYTES)),
  mediaType: v.pipe(
    v.string(),
    v.maxLength(256),
    v.check((value) => normalizeAttachmentMediaType(value) !== null),
    v.transform((value) => normalizeAttachmentMediaType(value)!),
  ),
  originalMediaType: v.optional(v.pipe(v.string(), v.maxLength(256))),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type AttachmentInput = v.InferOutput<typeof attachmentInputSchema>;
export const attachmentMediaTypeInputSchema = v.pipe(
  v.string(),
  v.maxLength(256),
  v.check((value) => normalizeAttachmentMediaType(value) !== null),
);
export function normalizeAttachmentMetadata<
  T extends { mediaType: string; originalMediaType?: string },
>(file: T) {
  const mediaType = normalizeAttachmentMediaType(file.mediaType)!;
  return {
    ...file,
    mediaType,
    ...(file.originalMediaType === undefined && mediaType !== file.mediaType
      ? { originalMediaType: file.mediaType }
      : {}),
  };
}
// Preserve the declared MIME before selecting the canonical processing pipeline.
export const attachmentUploadInputSchema = v.pipe(
  v.strictObject({ ...attachmentInputSchema.entries, mediaType: attachmentMediaTypeInputSchema }),
  v.transform(normalizeAttachmentMetadata),
);
export interface Attachment extends AttachmentInput {
  conversationId: string;
  status: 'registered' | 'uploading' | 'ready' | 'failed';
  createdAt: number;
  error: string | null;
}
export interface AttachmentUpload {
  attachment: Attachment;
  upload: null | {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
  };
}
export const attachmentUrl = (conversationId: string, id: string) =>
  `/api/conversations/${conversationId}/attachments/${id}/content`;
export const bytesLabel = (size: number) =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(size / 1024)} KiB`;
export function fileMediaType(
  name: string,
  declaredType = '',
): AttachmentInput['mediaType'] | null {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  const types: Record<string, AttachmentInput['mediaType']> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    md: 'text/markdown',
    csv: 'text/csv',
    pdf: 'application/pdf',
  };
  if (Object.hasOwn(types, extension)) return types[extension];
  // SVG is source text even though browsers classify its MIME as an image.
  if (extension === 'svg') return 'text/plain';
  if (
    ['txt', 'html', 'htm', 'xhtml', 'xml', 'json', 'jsonl', 'yaml', 'yml', 'toml'].includes(
      extension,
    )
  )
    return 'text/plain';
  return normalizeAttachmentMediaType(declaredType);
}

export function attachmentSignatureMatches(
  bytes: Uint8Array,
  mediaType: AttachmentInput['mediaType'],
) {
  const ascii = (start: number, text: string) =>
    [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0));
  if (mediaType === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mediaType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mediaType === 'image/webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (mediaType === 'application/pdf') return ascii(0, '%PDF-');
  return !bytes.includes(0); // Full UTF-8 validation belongs to the text extraction checkpoint.
}
