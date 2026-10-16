import { api, ApiError } from '../../platform/api';
import { read, storageEpoch, write } from '../../platform/storage';

export type BackupProgress = { value: number; label: string };
type RestorableArchive = { hash: string; manifest: Blob; files: { sourceId: string; original: Blob; text?: Blob }[] };
function archiveWorker<T>(request: unknown, signal: AbortSignal, progress: (value: BackupProgress) => void) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: unknown, value?: T) => {
      worker.terminate(); clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason), timeout = setTimeout(() => finish(new Error('备份处理超过 5 分钟，请重试。')), 5 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ progress?: BackupProgress; error?: string; result?: T }>) => {
      if (event.data.progress) progress(event.data.progress);
      else if (event.data.error) finish(new Error(event.data.error));
      else if (event.data.result) finish(undefined, event.data.result);
    };
    worker.onerror = () => finish(new Error('备份处理组件加载失败，请刷新后重试。'));
    worker.postMessage(request);
  });
}
export async function createArchive(id: string, signal: AbortSignal, progress: (value: BackupProgress) => void) {
  return (await archiveWorker<{ blob: Blob }>({ operation: 'export', id }, signal, progress)).blob;
}
function uploadBlob(url: string, body: Blob, signal: AbortSignal, progress: (loaded: number) => void, method = 'PUT') {
  return new Promise<unknown>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest(), abort = () => xhr.abort();
    xhr.open(method, `/api${url}`); xhr.withCredentials = true; xhr.timeout = 90_000;
    xhr.setRequestHeader('Content-Type', body.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => progress(Math.min(body.size, event.loaded));
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new ApiError(xhr.status, result.error ?? '恢复请求失败。', result.code);
        resolve(result);
      } catch (error) { reject(error); }
    };
    xhr.onerror = () => reject(new Error('恢复结果未确认，请重新导入同一存档查看结果。'));
    xhr.ontimeout = () => reject(new Error('恢复等待超时，请重新导入同一存档查看结果。'));
    xhr.onabort = () => reject(signal.reason ?? new DOMException('恢复已取消。', 'AbortError'));
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true }); xhr.send(body);
  });
}
export async function restoreArchive(file: File, signal: AbortSignal, progress: (value: BackupProgress) => void) {
  const epoch = storageEpoch();
  const archive = await archiveWorker<RestorableArchive>({ operation: 'import', file }, signal, (state) => progress({ ...state, value: state.value / 10 }));
  signal.throwIfAborted();
  const key = `import:${archive.hash}`, id = read<string | null>(key, null) ?? crypto.randomUUID(), path = `/backup/imports/${id}`;
  if (epoch !== storageEpoch()) throw new DOMException('恢复已取消。', 'AbortError');
  write(key, id);
  const clearIdentifier = () => { if (epoch === storageEpoch() && read<string | null>(key, null) === id) write(key, null); };
  let began = false;
  try {
    const begin = await uploadBlob(path, archive.manifest, signal, () => {}, 'POST') as { status: string };
    began = true;
    if (begin.status !== 'completed') {
      const total = archive.files.reduce((sum, item) => sum + item.original.size + (item.text?.size ?? 0), 0); let saved = 0;
      for (const item of archive.files) for (const [kind, blob] of [['content', item.original], ['text', item.text]] as const) if (blob) {
        await uploadBlob(`${path}/files/${item.sourceId}/${kind}`, blob, signal, (loaded) => progress({ value: 10 + Math.round((saved + loaded) / Math.max(1, total) * 75), label: '正在保存文件' }));
        saved += blob.size;
      }
    }
    progress({ value: 90, label: '正在保存对话' });
    const result = await api<{ id: string }>(`${path}/complete`, 'POST', undefined, signal);
    clearIdentifier(); return result;
  } catch (error) {
    if (signal.aborted) {
      void api(path, 'DELETE').then(clearIdentifier).catch(() => {});
    } else if (error instanceof ApiError && (error.code === 'import-stopped' || !began && error.status >= 400 && error.status < 500)) clearIdentifier();
    throw error;
  }
}
