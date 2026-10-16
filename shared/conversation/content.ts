import * as v from 'valibot';
import {
  documentPartSchema,
  MAX_MESSAGE_DOCUMENTS,
  type DocumentPart,
} from '../attachments/documents';
import { imagePartSchema, MAX_MESSAGE_IMAGES, type ImagePart } from '../attachments/images';

/** Current channels are aggregated independently; parts do not imply SSE event order. */
export type MessagePart =
  { type: 'text'; text: string } | { type: 'reasoning'; text: string } | ImagePart | DocumentPart;

/** One nonempty part per channel, with reasoning before the answer. */
export function messageParts(text: string, reasoning = ''): MessagePart[] {
  const parts: MessagePart[] = [];
  if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
  if (text) parts.push({ type: 'text', text });
  return parts;
}

export function messageText(
  message: { parts: readonly MessagePart[] } | undefined,
  type: 'text' | 'reasoning' = 'text',
): string {
  const part = message?.parts.find((part) => part.type === type);
  return part && 'text' in part ? part.text : '';
}
export const messageImages = (message: { parts: readonly MessagePart[] } | undefined) =>
  message?.parts.filter((part): part is ImagePart => part.type === 'image') ?? [];

export const messageFiles = (message: { parts: readonly MessagePart[] } | undefined) =>
  message?.parts.filter((part): part is DocumentPart => part.type === 'file') ?? [];
export const messageAttachments = (message: { parts: readonly MessagePart[] } | undefined) => [
  ...messageImages(message),
  ...messageFiles(message),
];

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000));
export const messagePartsSchema = v.pipe(
  v.array(
    v.variant('type', [
      v.strictObject({ type: v.literal('text'), text }),
      v.strictObject({ type: v.literal('reasoning'), text }),
      imagePartSchema,
      documentPartSchema,
    ]),
  ),
  v.maxLength(2 + MAX_MESSAGE_IMAGES + MAX_MESSAGE_DOCUMENTS),
  v.check((parts) => {
    const channels = parts.filter((part) => part.type === 'text' || part.type === 'reasoning'),
      images = parts.filter((part) => part.type === 'image'),
      files = parts.filter((part) => part.type === 'file');
    const attachments = [...images, ...files];
    return (
      images.length <= MAX_MESSAGE_IMAGES &&
      files.length <= MAX_MESSAGE_DOCUMENTS &&
      new Set(attachments.map((file) => file.attachmentId)).size === attachments.length &&
      channels.length <= 2 &&
      (channels.length < 2 || (channels[0].type === 'reasoning' && channels[1].type === 'text')) &&
      parts
        .slice(0, channels.length)
        .every((part) => part.type === 'text' || part.type === 'reasoning')
    );
  }, '消息内容部分的顺序或类型重复。'),
);
