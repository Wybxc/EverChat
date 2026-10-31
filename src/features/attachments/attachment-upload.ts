import * as v from 'valibot';
import {
  ATTACHMENT_UPLOAD_TIMEOUT,
  attachmentInputSchema,
  fileMediaType,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentInput,
  type AttachmentUpload,
} from '../../../shared/attachments/files';
import { api } from '../../platform/api';
import { UiError, uiMessage } from '../../platform/i18n/messages';
import { authenticatedUploadSignal } from '../../platform/xhr';
import { t } from './locales';

export async function prepareAttachment(file: File, signal: AbortSignal): Promise<AttachmentInput> {
  const mediaType = fileMediaType(file.name, file.type);
  if (!mediaType || file.size > MAX_ATTACHMENT_BYTES || !file.size)
    throw new UiError(uiMessage('attachments', 'invalidUpload'));
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  signal.throwIfAborted();
  const input = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    mediaType,
    originalMediaType: file.type,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
  if (!v.safeParse(attachmentInputSchema, input).success)
    throw new UiError(uiMessage('attachments', 'invalidName'));
  return input;
}
export const prepareAttachmentUploads = (
  conversationId: string,
  inputs: AttachmentInput[],
  signal: AbortSignal,
) =>
  api<AttachmentUpload[]>(
    `/conversations/${conversationId}/attachments/uploads`,
    'POST',
    inputs,
    signal,
  );

export async function uploadAttachment(
  conversationId: string,
  input: AttachmentInput,
  file: File,
  signal: AbortSignal,
  progress: (received: number) => void,
  prepared?: AttachmentUpload,
) {
  signal = authenticatedUploadSignal(signal);
  const receive = () =>
    api<Attachment>(
      `/conversations/${conversationId}/attachments/${input.id}/receive`,
      'POST',
      undefined,
      signal,
    );
  try {
    const target = prepared ?? (await prepareAttachmentUploads(conversationId, [input], signal))[0];
    signal.throwIfAborted();
    if (!target.upload) return target.attachment;
    const { upload } = target;
    const url = new URL(upload.url);
    if (
      !(
        url.protocol === 'https:' && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname)
      ) &&
      !(
        import.meta.env.DEV &&
        url.origin === location.origin &&
        url.pathname.startsWith('/__dev/r2/')
      )
    )
      throw new UiError(uiMessage('attachments', 'invalidResponse'));
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest(),
          abort = () => xhr.abort();
        xhr.open('PUT', upload.url);
        xhr.timeout = ATTACHMENT_UPLOAD_TIMEOUT;
        xhr.withCredentials = false;
        for (const [name, value] of Object.entries(upload.headers))
          xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (event) => progress(Math.min(file.size, event.loaded));
        xhr.onload = () => {
          // A previous PUT may have succeeded even if its response was lost.
          if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 412) resolve();
          else reject(new UiError(uiMessage('attachments', 'r2Rejected', { status: xhr.status })));
        };
        xhr.onerror = () => reject(new UiError(uiMessage('attachments', 'interrupted')));
        xhr.ontimeout = () => reject(new UiError(uiMessage('attachments', 'timeout')));
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
      signal.throwIfAborted();
      // Reconcile an ambiguous network result without uploading a second copy.
      try {
        return await receive();
      } catch {
        throw error;
      }
    }
    return await receive();
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
