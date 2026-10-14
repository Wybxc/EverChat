import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Trash2, X } from 'lucide-react';
import { attachmentUrl, bytesLabel, type Attachment } from '../shared/attachments';
import { api } from './api';
import { prepareAttachment, uploadAttachment } from './attachment-upload';

export function AttachmentDialog({ id, open, close }: { id: string; open: boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), picker = useRef<HTMLInputElement>(null), titleId = useId();
  const controller = useRef<AbortController | null>(null), client = useQueryClient();
  const [upload, setUpload] = useState<{ name: string; size: number; sent: number } | null>(null);
  const [error, setError] = useState(''), [removing, setRemoving] = useState<string | null>(null);
  const key = ['attachments', id];
  const files = useQuery({ queryKey: key, queryFn: () => api<Attachment[]>(`/conversations/${id}/attachments`), enabled: open, refetchInterval: open ? 3000 : false });
  useEffect(() => { if (open) { dialog.current?.showModal(); picker.current?.focus(); } else dialog.current?.close(); }, [open]);
  useEffect(() => () => controller.current?.abort(), []);
  const selectFiles = async (items: FileList | null) => {
    if (!items?.length || controller.current) return;
    const abort = new AbortController(); controller.current = abort; setError('');
    try {
      for (const file of Array.from(items)) {
        setUpload({ name: file.name, size: file.size, sent: 0 });
        const input = await prepareAttachment(file, abort.signal);
        await uploadAttachment(id, input, file, abort.signal, (sent) => setUpload({ name: file.name, size: file.size, sent }));
        await client.invalidateQueries({ queryKey: key });
      }
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '上传失败。'); }
    finally { controller.current = null; setUpload(null); if (picker.current) picker.current.value = ''; void client.invalidateQueries({ queryKey: key }); }
  };
  const remove = async (file: Attachment) => {
    setError(''); setRemoving(file.id);
    try { await api(`/conversations/${id}/attachments/${file.id}`, 'DELETE'); await client.invalidateQueries({ queryKey: key }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '删除失败。'); }
    finally { setRemoving(null); }
  };
  return <dialog ref={dialog} id={`attachments-${titleId}`} className="modal" aria-labelledby={titleId} onClose={close}>
    <div className="modal-box flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 p-5"><h2 id={titleId} className="text-lg font-semibold">对话文件</h2>
        <form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭对话文件"><X size={18} /></button></form>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <label className="block space-y-2 text-sm"><span>上传文件</span><input ref={picker} type="file" multiple aria-label="上传文件" className="file-input w-full" disabled={Boolean(upload) || !navigator.onLine}
          accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.pdf,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh" onChange={(event) => void selectFiles(event.currentTarget.files)} /></label>
        <p className="mt-2 text-xs text-base-content/70">单文件 ≤5 MiB · 此处仅保存文件</p>
        {upload && <div role="status" className="mt-4 space-y-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{upload.name} · {upload.sent === upload.size ? '保存中…' : `${Math.round(upload.sent / Math.max(1, upload.size) * 100)}%`}</span>
          <button type="button" className="btn btn-sm" onClick={() => controller.current?.abort()}>取消上传</button></div><progress className="progress w-full" aria-label="上传进度" value={upload.sent} max={Math.max(1, upload.size)} /></div>}
        {(error || files.error) && <p role="alert" className="mt-4 text-sm">{error || files.error?.message}</p>}
        {files.isPending ? <p className="mt-5 text-sm">正在读取…</p> : <ul className="list mt-4">
          {files.data?.map((file) => <li key={file.id} className="list-row px-0"><File size={20} /><div className="min-w-0"><p className="truncate text-sm">{file.name}</p><p className="mt-1 text-xs text-base-content/70">{bytesLabel(file.size)} · {file.status === 'ready' ? '已保存' : file.status === 'uploading' ? '上传中' : file.status === 'failed' ? '上传失败' : '等待上传'}</p></div>
            <div className="flex items-center gap-1">{file.status === 'ready' && <a className="btn btn-ghost btn-sm" href={attachmentUrl(id, file.id)} download={file.name}>下载</a>}
              <button type="button" className="btn btn-ghost btn-sm btn-square" aria-label={`删除文件 ${file.name}`} disabled={Boolean(removing) || !navigator.onLine} onClick={() => void remove(file)}><Trash2 size={16} /></button></div>
          </li>)}
        </ul>}
        {files.data?.length === 0 && <p className="mt-5 text-sm text-base-content/70">暂无文件</p>}
      </div>
    </div>
  </dialog>;
}
