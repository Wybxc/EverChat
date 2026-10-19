import { t } from './locales';
import * as v from 'valibot';
import {
  attachmentInputSchema,
  attachmentUrl,
  fileMediaType,
  ATTACHMENT_UPLOAD_TIMEOUT,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentInput,
} from '../../../shared/attachments/files';
import { api } from '../../platform/api';
import { authenticatedUploadSignal, xhrJson } from '../../platform/xhr';

export async function prepareAttachment(file: File, signal: AbortSignal): Promise<AttachmentInput> {
  const mediaType = fileMediaType(file.name);
  if (!mediaType || file.size > MAX_ATTACHMENT_BYTES || !file.size)
    throw new Error(t(($) => $.invalidUpload));
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  signal.throwIfAborted();
  const input = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    mediaType,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
  if (!v.safeParse(attachmentInputSchema, input).success) throw new Error(t(($) => $.invalidName));
  return input;
}
export async function uploadAttachment(
  conversationId: string,
  input: AttachmentInput,
  file: File,
  signal: AbortSignal,
  progress: (received: number) => void,
) {
  signal = authenticatedUploadSignal(signal);
  try {
    await api<Attachment>(`/conversations/${conversationId}/attachments`, 'POST', input, signal);
    signal.throwIfAborted();
    return await new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest(),
        abort = () => xhr.abort();
      xhr.open('PUT', attachmentUrl(conversationId, input.id));
      xhr.timeout = ATTACHMENT_UPLOAD_TIMEOUT;
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', input.mediaType);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.upload.onprogress = (event) => progress(Math.min(file.size, event.loaded));
      xhr.onload = () => {
        try {
          const body = xhrJson(
            xhr,
            t(($) => $.uploadFailed),
          );
          resolve(body as Attachment);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(t(($) => $.invalidResponse)));
        }
      };
      xhr.onerror = () => reject(new Error(t(($) => $.interrupted)));
      xhr.ontimeout = () => reject(new Error(t(($) => $.timeout)));
      xhr.onabort = () =>
        reject(
          new DOMException(
            t(($) => $.cancelled),
            'AbortError',
          ),
        );
      xhr.onloadend = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
        return;
      }
      xhr.send(file);
    });
  } catch (error) {
    if (signal.aborted)
      await api(
        `/conversations/${conversationId}/attachments/${input.id}`,
        'DELETE',
        undefined,
        AbortSignal.timeout(10_000),
      ).catch(() => {});
    throw error;
  }
}
