import { decodeBackup, encodeArchive } from '../../../shared/backup/codec';
import { extractedPath, MAX_ARCHIVE_BYTES, originalPath, sha256, validateArchiveManifest } from '../../../shared/backup/archive';
import { attachmentUrl } from '../../../shared/attachments/files';

const progress = (value: number, label: string) => self.postMessage({ progress: { value, label } });
async function privateGet(url: string) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    let message = '备份资料无法读取。';
    try { const body = await response.json() as { error?: string }; if (body.error) message = body.error; } catch { /* Keep the readable fallback. */ }
    throw new Error(message);
  }
  return response;
}
self.onmessage = async (event: MessageEvent<{ operation: 'export'; id: string } | { operation: 'import'; file: File }>) => {
  try {
    const request = event.data;
    if (request.operation === 'export') {
      progress(0, '正在读取备份资料');
      const manifest = validateArchiveManifest(await (await privateGet(`/api/conversations/${request.id}/backup/manifest`)).json());
      const entries: Record<string, Uint8Array> = {}, total = manifest.files.length;
      for (let index = 0; index < total; index++) {
        const file = manifest.files[index];
        entries[originalPath(file.id)] = new Uint8Array(await (await privateGet(attachmentUrl(request.id, file.id))).arrayBuffer());
        if (file.parsed) {
          const saved = await (await privateGet(`/api/conversations/${request.id}/attachments/${file.id}/document`)).json() as { text: string };
          entries[extractedPath(file.id)] = new TextEncoder().encode(saved.text);
        }
        progress(Math.round((index + 1) / Math.max(1, total) * 90), '正在读取文件');
      }
      progress(95, '正在生成备份');
      const bytes = await encodeArchive(manifest, entries);
      self.postMessage({ result: { blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }) } });
    } else {
      if (!request.file.size || request.file.size > MAX_ARCHIVE_BYTES) throw new Error('备份存档大小无效。');
      progress(0, '正在检查备份');
      const bytes = new Uint8Array(await request.file.arrayBuffer()), hash = await sha256(bytes);
      const decoded = await decodeBackup(bytes);
      const files = decoded.manifest.files.map((file) => ({ sourceId: file.id,
        original: new Blob([new Uint8Array(decoded.entries[originalPath(file.id)])], { type: file.mediaType }),
        ...(file.parsed ? { text: new Blob([new Uint8Array(decoded.entries[extractedPath(file.id)])], { type: 'text/plain;charset=utf-8' }) } : {}) }));
      progress(100, '备份检查完成');
      self.postMessage({ result: { hash, manifest: new Blob([JSON.stringify(decoded.manifest)], { type: 'application/json' }), files } });
    }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '备份处理失败。' }); }
};
