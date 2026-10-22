import type { TextUIPart, ReasoningUIPart } from 'ai';
import * as v from 'valibot';
import { MAX_MESSAGE_TEXT_BYTES, MESSAGE_TEXT_LIMIT_MESSAGE, messageTextFits } from './limits';
import {
  documentPartSchema,
  MAX_MESSAGE_DOCUMENTS,
  type DocumentPart,
} from '../attachments/documents';
import { imagePartSchema, MAX_MESSAGE_IMAGES, type ImagePart } from '../attachments/images';

/** SDK UI text shapes; EverChat aggregates channels independently of SSE event order. */
export type MessagePart =
  | Pick<TextUIPart, 'type' | 'text'>
  | Pick<ReasoningUIPart, 'type' | 'text'>
  | ImagePart
  | DocumentPart;

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

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MESSAGE_TEXT_BYTES));
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
  v.check(
    (parts) => messageTextFits(messageText({ parts }), messageText({ parts }, 'reasoning')),
    MESSAGE_TEXT_LIMIT_MESSAGE,
  ),
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
