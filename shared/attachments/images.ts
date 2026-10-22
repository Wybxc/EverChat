import { imageSize } from 'image-size';
import * as v from 'valibot';
import { AppError, problem, type ErrorIssue } from '../errors/descriptor';
import { canAttemptCapability } from '../models/metadata';
import type { ChatInput, ProviderConfig } from '../providers/types';
import { attachmentInputSchema, attachmentSignatureMatches, MAX_ATTACHMENT_BYTES } from './files';
import { MAX_BUFFERED_BODY_BYTES } from '../platform/limits';

export const imageMediaTypeSchema = v.picklist(['image/png', 'image/jpeg', 'image/webp']);
export const imagePartSchema = v.strictObject({
  type: v.literal('image'),
  attachmentId: attachmentInputSchema.entries.id,
  name: attachmentInputSchema.entries.name,
  sha256: attachmentInputSchema.entries.sha256,
  size: attachmentInputSchema.entries.size,
  mediaType: imageMediaTypeSchema,
});
export type ImagePart = v.InferOutput<typeof imagePartSchema>;
export class ImageContextError extends AppError {
  constructor(message: string, issue: ErrorIssue = problem('ATTACHMENT_INVALID')) {
    super(issue, message);
  }
}
export function assertImageContext(
  context: readonly ChatInput[],
  config: Pick<ProviderConfig, 'modelMetadata'>,
) {
  let count = 0;
  let requestBytes = 0;
  for (const message of context) {
    if (!message.images?.length) continue;
    if (message.role !== 'user') throw new ImageContextError('图片只能放在用户消息中。');
    count += message.images.length;
    for (const image of message.images) {
      if (!v.safeParse(imagePartSchema, image).success)
        throw new ImageContextError('图片引用无效，请重新上传。');
      requestBytes += Math.ceil(image.size / 3) * 4;
    }
  }
  if (requestBytes > MAX_BUFFERED_BODY_BYTES)
    throw new ImageContextError(
      '本次图片编码后超过单次模型请求的内存保护大小，请减少图片或缩小原图。',
    );
  if (count && !canAttemptCapability(config.modelMetadata, 'imageInput'))
    throw new ImageContextError(
      '所选模型不支持图片，请选择视觉模型或调整模型能力设置。',
      problem('IMAGE_UNSUPPORTED'),
    );
}
export function imageDimensions(bytes: Uint8Array, mediaType: ImagePart['mediaType']) {
  if (!attachmentSignatureMatches(bytes, mediaType))
    throw new ImageContextError('图片内容与类型不符。');
  try {
    const dimensions = imageSize(bytes);
    const expected = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6);
    if (
      dimensions.type !== expected ||
      !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 1 ||
      dimensions.height < 1
    )
      throw new Error('Invalid dimensions');
    return { width: dimensions.width, height: dimensions.height };
  } catch {
    throw new ImageContextError('图片无效或无法读取尺寸。');
  }
}
export function assertChatImage(bytes: Uint8Array, mediaType: ImagePart['mediaType']) {
  imageDimensions(bytes, mediaType);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new ImageContextError('图片超过 Cloudflare 单次请求大小。');
}
