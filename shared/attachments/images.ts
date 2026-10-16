import { imageSize } from 'image-size';
import * as v from 'valibot';
import { attachmentInputSchema,attachmentSignatureMatches } from './files';
import { canAttemptCapability } from '../models/metadata';
import type { ChatInput, ProviderConfig } from '../providers/types';

export const MAX_MESSAGE_IMAGES = 4, MAX_CONTEXT_IMAGES = 8;
export const MAX_CHAT_IMAGE_BYTES = 1024 * 1024, MAX_CHAT_IMAGE_EDGE = 1536;
export const MAX_SOURCE_IMAGE_PIXELS = 24_000_000;
// A conservative planning allowance, not a supplier tokenizer or billed usage.
export const IMAGE_TOKEN_ALLOWANCE = 4096;
export const imageMediaTypeSchema = v.picklist(['image/png', 'image/jpeg', 'image/webp']);
export const imagePartSchema = v.strictObject({
  type: v.literal('image'), attachmentId: attachmentInputSchema.entries.id,
  name: attachmentInputSchema.entries.name, sha256: attachmentInputSchema.entries.sha256,
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CHAT_IMAGE_BYTES)),
  mediaType: imageMediaTypeSchema,
});
export type ImagePart = v.InferOutput<typeof imagePartSchema>;
export class ImageContextError extends Error {}
export const imageTokens = (images: readonly ImagePart[] = []) => images.length * IMAGE_TOKEN_ALLOWANCE;
export function assertImageContext(context: readonly ChatInput[], config: Pick<ProviderConfig, 'modelMetadata'>) {
  let count = 0, bytes = 0;
  for (const message of context) {
    if (!message.images?.length) continue;
    if (message.role !== 'user') throw new ImageContextError('图片只能放在用户消息中。');
    count += message.images.length;
    for (const image of message.images) {
      if (!v.safeParse(imagePartSchema, image).success) throw new ImageContextError('图片引用无效，请重新上传。');
      bytes += image.size;
    }
  }
  if (count && !canAttemptCapability(config.modelMetadata, 'imageInput')) throw new ImageContextError('所选模型不支持图片，请选择视觉模型或调整模型能力设置。');
  if (count > MAX_CONTEXT_IMAGES || bytes > MAX_CONTEXT_IMAGES * MAX_CHAT_IMAGE_BYTES) throw new ImageContextError('本次上下文最多包含 8 张图片，请缩短历史或新建对话。');
}
export function imageDimensions(bytes: Uint8Array, mediaType: ImagePart['mediaType']) {
  if (!attachmentSignatureMatches(bytes, mediaType)) throw new ImageContextError('图片内容与类型不符。');
  try {
    const dimensions = imageSize(bytes);
    const expected = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6);
    if (dimensions.type !== expected || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
      || dimensions.width < 1 || dimensions.height < 1) throw new Error('Invalid dimensions');
    return { width: dimensions.width, height: dimensions.height };
  } catch { throw new ImageContextError('图片无效或无法读取尺寸。'); }
}
export function assertChatImage(bytes: Uint8Array, mediaType: ImagePart['mediaType']) {
  const { width, height } = imageDimensions(bytes, mediaType);
  if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES || width > MAX_CHAT_IMAGE_EDGE || height > MAX_CHAT_IMAGE_EDGE) throw new ImageContextError('图片超过聊天输入限制，请重新上传以缩放图片。');
}
