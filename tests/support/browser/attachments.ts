import { expect, type APIRequestContext } from '@playwright/test';
import type { Attachment, AttachmentUpload } from '../../../shared/attachments/files';

export const attachmentHeaders = { Origin: 'http://127.0.0.1:5174' };
export const receiveAttachment = (request: APIRequestContext, conversationId: string, id: string) =>
  request.post(`/api/conversations/${conversationId}/attachments/${id}/receive`, {
    headers: attachmentHeaders,
  });

export async function directUpload(
  request: APIRequestContext,
  conversationId: string,
  id: string,
  bytes: Buffer,
  receive = true,
) {
  const files: Attachment[] = await (
    await request.get(`/api/conversations/${conversationId}/attachments`)
  ).json();
  const input = files.find((file) => file.id === id);
  if (!input) return receiveAttachment(request, conversationId, id);
  const { name, size, mediaType, sha256, originalMediaType } = input;
  const prepared = await request.post(`/api/conversations/${conversationId}/attachments/uploads`, {
    headers: attachmentHeaders,
    data: [
      {
        id,
        name,
        size,
        mediaType,
        sha256,
        ...(originalMediaType !== undefined ? { originalMediaType } : {}),
      },
    ],
  });
  if (!prepared.ok()) return prepared;
  const [target]: AttachmentUpload[] = await prepared.json();
  if (target.upload) {
    // A separate context is not required: this endpoint uses only SigV4 and
    // explicitly receives no Access headers. Browser tests check credentials too.
    const put = await request.put(target.upload.url, {
      headers: target.upload.headers,
      data: bytes,
    });
    expect([200, 412]).toContain(put.status());
    if (!receive) return put;
  }
  return receiveAttachment(request, conversationId, id);
}
