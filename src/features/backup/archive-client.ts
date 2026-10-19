import { type ErrorIssue, readErrorIssue } from '../../../shared/errors/descriptor';
import { api, ApiError } from '../../platform/api';
import { notifyAuthFailure } from '../../platform/auth';
import { issueMessage, UiError, uiMessage } from '../../platform/i18n/messages';
import { read, storageEpoch, write } from '../../platform/storage';
import { authenticatedUploadSignal, xhrJson } from '../../platform/xhr';
import { t } from './locales';

export type BackupStage =
  | 'readingData'
  | 'readingFiles'
  | 'generating'
  | 'checking'
  | 'checked'
  | 'savingFiles'
  | 'savingChat';
export type BackupProgress = { value: number; label: BackupStage };
type RestorableArchive = {
  hash: string;
  manifest: Blob;
  files: { sourceId: string; original: Blob; text?: Blob }[];
};
function archiveWorker<T>(
  request: unknown,
  signal: AbortSignal,
  progress: (value: BackupProgress) => void,
) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const finish = (error?: unknown, value?: T) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal.reason),
      timeout = setTimeout(() => finish(new UiError(uiMessage('backup', 'timeout'))), 5 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{
        progress?: BackupProgress;
        error?: string;
        issue?: ErrorIssue;
        status?: number;
        code?: string;
        result?: T;
      }>,
    ) => {
      if (event.data.progress) progress(event.data.progress);
      else if (event.data.error) {
        const { error, status, code, issue: rawIssue } = event.data;
        const issue = readErrorIssue(rawIssue);
        const message = issue ? issueMessage(issue) : uiMessage('backup', 'processingFailed');
        finish(status ? new ApiError(status, error, code, undefined, issue) : new UiError(message));
        if (status) notifyAuthFailure(status, code);
      } else if (event.data.result) finish(undefined, event.data.result);
    };
    worker.onerror = () => finish(new UiError(uiMessage('backup', 'workerFailed')));
    worker.postMessage(request);
  });
}
export async function createArchive(
  id: string,
  signal: AbortSignal,
  progress: (value: BackupProgress) => void,
) {
  return (
    await archiveWorker<{ blob: Blob }>(
      { operation: 'export', id },
      authenticatedUploadSignal(signal),
      progress,
    )
  ).blob;
}
function uploadBlob(
  url: string,
  body: Blob,
  signal: AbortSignal,
  progress: (loaded: number) => void,
  method = 'PUT',
) {
  signal = authenticatedUploadSignal(signal);
  return new Promise<unknown>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest(),
      abort = () => xhr.abort();
    xhr.open(method, `/api${url}`);
    xhr.withCredentials = true;
    xhr.timeout = 90_000;
    xhr.setRequestHeader('Content-Type', body.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.upload.onprogress = (event) => progress(Math.min(body.size, event.loaded));
    xhr.onload = () => {
      try {
        const result = xhrJson(
          xhr,
          t(($) => $.restoreFailed),
        );
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new UiError(uiMessage('backup', 'unconfirmed')));
    xhr.ontimeout = () => reject(new UiError(uiMessage('backup', 'restoreTimeout')));
    xhr.onabort = () =>
      reject(
        signal.reason ??
          new DOMException(
            t(($) => $.cancelled),
            'AbortError',
          ),
      );
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}
export async function restoreArchive(
  file: File,
  signal: AbortSignal,
  progress: (value: BackupProgress) => void,
) {
  signal = authenticatedUploadSignal(signal);
  const epoch = storageEpoch();
  const archive = await archiveWorker<RestorableArchive>(
    { operation: 'import', file },
    signal,
    (state) => progress({ ...state, value: state.value / 10 }),
  );
  signal.throwIfAborted();
  const key = `import:${archive.hash}`,
    id = read<string | null>(key, null) ?? crypto.randomUUID(),
    path = `/backup/imports/${id}`;
  if (epoch !== storageEpoch())
    throw new DOMException(
      t(($) => $.cancelled),
      'AbortError',
    );
  write(key, id);
  const clearIdentifier = () => {
    if (epoch === storageEpoch() && read<string | null>(key, null) === id) write(key, null);
  };
  let began = false;
  try {
    const begin = (await uploadBlob(path, archive.manifest, signal, () => {}, 'POST')) as {
      status: string;
    };
    began = true;
    if (begin.status !== 'completed') {
      const total = archive.files.reduce(
        (sum, item) => sum + item.original.size + (item.text?.size ?? 0),
        0,
      );
      let saved = 0;
      for (const item of archive.files)
        for (const [kind, blob] of [
          ['content', item.original],
          ['text', item.text],
        ] as const)
          if (blob) {
            await uploadBlob(`${path}/files/${item.sourceId}/${kind}`, blob, signal, (loaded) =>
              progress({
                value: 10 + Math.round(((saved + loaded) / Math.max(1, total)) * 75),
                label: 'savingFiles',
              }),
            );
            saved += blob.size;
          }
    }
    progress({ value: 90, label: 'savingChat' });
    const result = await api<{ id: string }>(`${path}/complete`, 'POST', undefined, signal);
    clearIdentifier();
    return result;
  } catch (error) {
    if (signal.aborted) {
      void api(path, 'DELETE')
        .then(clearIdentifier)
        .catch(() => {});
    } else if (
      error instanceof ApiError &&
      (error.code === 'import-stopped' ||
        (!began && error.status >= 400 && error.status < 500 && ![401, 403].includes(error.status)))
    )
      clearIdentifier();
    throw error;
  }
}
