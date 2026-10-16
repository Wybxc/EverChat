import * as v from 'valibot';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_SPACE_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MAX_CONVERSATION_ATTACHMENTS = 64, MAX_SPACE_ATTACHMENTS = 512;
export const MAX_DAILY_ATTACHMENT_UPLOADS = 100;
export const ATTACHMENT_UPLOAD_TIMEOUT = 60_000, ATTACHMENT_LEASE = 5 * 60_000;
export const attachmentInputSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.check((name) => Boolean(name.trim()) && !/[\u0000-\u001f\u007f/\\]/.test(name))),
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ATTACHMENT_BYTES)),
  mediaType: v.picklist(['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/markdown', 'text/csv', 'application/pdf']),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type AttachmentInput = v.InferOutput<typeof attachmentInputSchema>;
export interface Attachment extends AttachmentInput {
  conversationId: string; status: 'registered' | 'uploading' | 'ready' | 'failed'; createdAt: number;
  error: string | null;
}
export const attachmentUrl = (conversationId: string, id: string) => `/api/conversations/${conversationId}/attachments/${id}/content`;
export const bytesLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(size / 1024)} KiB`;
export function fileMediaType(name: string): AttachmentInput['mediaType'] | null {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  const types: Record<string, AttachmentInput['mediaType']> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf' };
  if (Object.hasOwn(types, extension)) return types[extension];
  return /^(txt|js|jsx|ts|tsx|py|rs|go|c|cpp|h|css|json|yaml|yml|toml|sh)$/.test(extension) ? 'text/plain' : null;
}

export function attachmentSignatureMatches(bytes: Uint8Array, mediaType: AttachmentInput['mediaType']) {
  const ascii = (start: number, text: string) => [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0));
  if (mediaType === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mediaType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mediaType === 'image/webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (mediaType === 'application/pdf') return ascii(0, '%PDF-');
  return !bytes.includes(0); // Full UTF-8 validation belongs to the text extraction checkpoint.
}
