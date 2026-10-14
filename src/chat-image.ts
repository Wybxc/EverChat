import { imageDimensions, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_EDGE, MAX_SOURCE_IMAGE_PIXELS, imageMediaTypeSchema } from '../shared/images';
import { fileMediaType, MAX_ATTACHMENT_BYTES } from '../shared/attachments';
import * as v from 'valibot';

export async function prepareChatImage(file: File, signal: AbortSignal): Promise<File> {
  const type = v.safeParse(imageMediaTypeSchema, file.type || fileMediaType(file.name));
  if (!type.success || !file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error('请选择不超过 5 MiB 的 PNG、JPEG 或 WebP 图片。');
  const dimensions = imageDimensions(new Uint8Array(await file.arrayBuffer()), type.output);
  if (dimensions.width * dimensions.height > MAX_SOURCE_IMAGE_PIXELS) throw new Error('图片超过 2400 万像素，请先缩小图片。');
  signal.throwIfAborted();
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('图片无法解码，请选择其他图片。'); }
  try {
    signal.throwIfAborted();
    let scale = Math.min(1, MAX_CHAT_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法处理图片。');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
      signal.throwIfAborted();
      if (!blob) throw new Error('图片转换失败。');
      if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
        const extension = blob.type === 'image/png' ? 'png' : 'webp';
        return new File([blob], `${file.name.replace(/\.[^.]+$/, '').slice(0, 160) || '图片'}.${extension}`, { type: blob.type });
      }
      scale *= 0.7;
    }
    throw new Error('图片压缩后仍超过 1 MiB，请先缩小图片。');
  } finally { bitmap.close(); }
}
