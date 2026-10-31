import { attachmentUrl } from '../../../shared/attachments/files';
import {
  extractedPath,
  MAX_ARCHIVE_BYTES,
  originalPath,
  sha256,
  validateArchiveManifest,
} from '../../../shared/backup/archive';
import { decodeBackup, encodeArchive } from '../../../shared/backup/codec';
import {
  AppError,
  type ErrorIssue,
  issueOf,
  problem,
  readErrorIssue,
} from '../../../shared/errors/descriptor';
import type { BackupStage } from './archive-client';

class PrivateReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly issue?: ErrorIssue,
  ) {
    super(message);
  }
}
const progress = (value: number, label: BackupStage) =>
  self.postMessage({ progress: { value, label } });
async function privateGet(url: string) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!response.ok) {
    let message = 'Could not read backup data.',
      code: string | undefined;
    let issue: ErrorIssue | undefined;
    try {
      const body = (await response.json()) as { error?: string; code?: string; issue?: unknown };
      if (body.error) message = body.error;
      code = body.code;
      issue = readErrorIssue(body.issue);
    } catch {
      /* Keep the readable fallback. */
    }
    throw new PrivateReadError(message, response.status, code, issue);
  }
  return response;
}
self.onmessage = async (
  event: MessageEvent<{ operation: 'export'; id: string } | { operation: 'import'; file: File }>,
) => {
  try {
    const request = event.data;
    if (request.operation === 'export') {
      progress(0, 'readingData');
      const manifest = validateArchiveManifest(
        await (await privateGet(`/api/conversations/${request.id}/backup/manifest`)).json(),
      );
      const entries: Record<string, Uint8Array> = {},
        total = manifest.files.length;
      for (let index = 0; index < total; index++) {
        const file = manifest.files[index];
        entries[originalPath(file.id)] = new Uint8Array(
          await (await privateGet(attachmentUrl(request.id, file.id))).arrayBuffer(),
        );
        if (file.parsed) {
          entries[extractedPath(file.id)] = new Uint8Array(
            await (
              await privateGet(
                `/api/conversations/${request.id}/attachments/${file.id}/document/content`,
              )
            ).arrayBuffer(),
          );
        }
        progress(Math.round(((index + 1) / Math.max(1, total)) * 90), 'readingFiles');
      }
      progress(95, 'generating');
      const bytes = await encodeArchive(manifest, entries);
      self.postMessage({
        result: { blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }) },
      });
    } else {
      if (!request.file.size || request.file.size > MAX_ARCHIVE_BYTES)
        throw new AppError(problem('BACKUP_INVALID_SIZE'));
      progress(0, 'checking');
      const bytes = new Uint8Array(await request.file.arrayBuffer()),
        hash = await sha256(bytes);
      const decoded = await decodeBackup(bytes);
      const files = decoded.manifest.files.map((file) => ({
        sourceId: file.id,
        original: new Blob([new Uint8Array(decoded.entries[originalPath(file.id)])], {
          type: file.mediaType,
        }),
        ...(file.parsed
          ? {
              text: new Blob([new Uint8Array(decoded.entries[extractedPath(file.id)])], {
                type: 'text/plain;charset=utf-8',
              }),
            }
          : {}),
      }));
      progress(100, 'checked');
      self.postMessage({
        result: {
          hash,
          manifest: new Blob([JSON.stringify(decoded.manifest)], { type: 'application/json' }),
          files,
        },
      });
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Backup processing failed.',
      issue:
        error instanceof PrivateReadError
          ? error.issue
          : issueOf(error, event.data.operation === 'import' ? 'BACKUP_INVALID' : 'REQUEST_FAILED'),
      ...(error instanceof PrivateReadError ? { status: error.status, code: error.code } : {}),
    });
  }
};
