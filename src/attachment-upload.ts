import * as v from 'valibot';
import { attachmentInputSchema, attachmentUrl, fileMediaType, ATTACHMENT_UPLOAD_TIMEOUT, MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentInput } from '../shared/attachments';
import { api, ApiError } from './api';

export async function prepareAttachment(file: File, signal: AbortSignal): Promise<AttachmentInput> {
  const mediaType = fileMediaType(file.name);
  if (!mediaType || file.size > MAX_ATTACHMENT_BYTES || !file.size) throw new Error('请选择不超过 5 MiB 的图片、文本、代码或 PDF 文件。');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  signal.throwIfAborted();
  const input = { id: crypto.randomUUID(), name: file.name, size: file.size, mediaType,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
  if (!v.safeParse(attachmentInputSchema, input).success) throw new Error('文件名无效，请重命名后重试。');
  return input;
}
export async function uploadAttachment(conversationId: string, input: AttachmentInput, file: File, signal: AbortSignal, progress: (received: number) => void) {
  try {
    await api<Attachment>(`/conversations/${conversationId}/attachments`, 'POST', input, signal);
    signal.throwIfAborted();
    return await new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest(), abort = () => xhr.abort();
      xhr.open('PUT', attachmentUrl(conversationId, input.id)); xhr.timeout = ATTACHMENT_UPLOAD_TIMEOUT; xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', input.mediaType);
      xhr.upload.onprogress = (event) => progress(Math.min(file.size, event.loaded));
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) throw new ApiError(xhr.status, body.error ?? '附件上传失败。');
          resolve(body as Attachment);
        } catch (error) { reject(error instanceof Error ? error : new Error('附件响应无效。')); }
      };
      xhr.onerror = () => reject(new Error('上传中断，请联网后重试。'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试。'));
      xhr.onabort = () => reject(new DOMException('已取消上传。', 'AbortError'));
      xhr.onloadend = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abort); reject(signal.reason); return; }
      xhr.send(file);
    });
  } catch (error) {
    if (signal.aborted) await api(`/conversations/${conversationId}/attachments/${input.id}`, 'DELETE', undefined, AbortSignal.timeout(10_000)).catch(() => {});
    throw error;
  }
}
