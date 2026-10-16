import { Modal, ModalTitle } from './Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Trash2, X } from 'lucide-react';
import { attachmentUrl, bytesLabel, type Attachment } from '../shared/attachments/files';
import { api } from './api';
import { prepareAttachment, uploadAttachment } from './attachment-upload';

export function AttachmentDialog({ id, open, close }: { id: string; open: boolean; close: () => void }) {
  const picker = useRef<HTMLInputElement>(null), titleId = useId();
  const controller = useRef<AbortController | null>(null), client = useQueryClient();
  const [upload, setUpload] = useState<{ name: string; size: number; sent: number } | null>(null);
  const [error, setError] = useState(''), [removing, setRemoving] = useState<string | null>(null);
  const key = ['attachments', id];
  const files = useQuery({ queryKey: key, queryFn: () => api<Attachment[]>(`/conversations/${id}/attachments`), enabled: open, refetchInterval: open ? 3000 : false });
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
  return <Modal open={open} onOpenChange={(next) => { if (!next) close(); }} initialFocus={picker} aria-labelledby={titleId}>
    <div className="w-full flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 p-5"><ModalTitle id={titleId} className="text-lg font-semibold">对话文件</ModalTitle>
        <div><Button variant="ghost" size="icon" onClick={close} aria-label="关闭对话文件"><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <label className="block space-y-2 text-sm"><span>上传文件</span><Input ref={picker} type="file" multiple aria-label="上传文件" className="w-full" disabled={Boolean(upload) || !navigator.onLine}
          accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.pdf,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh" onChange={(event) => void selectFiles(event.currentTarget.files)} /></label>
        <p className="mt-2 text-xs text-muted-foreground">单文件 ≤5 MiB · 此处仅保存文件</p>
        {upload && <div role="status" className="mt-4 space-y-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{upload.name} · {upload.sent === upload.size ? '保存中…' : `${Math.round(upload.sent / Math.max(1, upload.size) * 100)}%`}</span>
          <Button variant="secondary" type="button" onClick={() => controller.current?.abort()}>取消上传</Button></div><progress className="progress-meter w-full" aria-label="上传进度" value={upload.sent} max={Math.max(1, upload.size)} /></div>}
        {(error || files.error) && <p role="alert" className="mt-4 text-sm">{error || files.error?.message}</p>}
        {files.isPending ? <p className="mt-5 text-sm">正在读取…</p> : <ul className="mt-4 divide-y divide-border">
          {files.data?.map((file) => <li key={file.id} className="flex items-center gap-3 py-3 [&>div:first-of-type]:flex-1"><File className="h-[1.25rem] w-[1.25rem]" /><div className="min-w-0"><p className="truncate text-sm">{file.name}</p><p className="mt-1 text-xs text-muted-foreground">{bytesLabel(file.size)} · {file.status === 'ready' ? '已保存' : file.status === 'uploading' ? '上传中' : file.status === 'failed' ? '上传失败' : '等待上传'}</p></div>
            <div className="flex items-center gap-1">{file.status === 'ready' && <a className="inline-flex min-h-11 items-center rounded-lg px-3 hover:bg-muted " href={attachmentUrl(id, file.id)} download={file.name}>下载</a>}
              <Button variant="ghost" size="icon" type="button" aria-label={`删除文件 ${file.name}`} disabled={Boolean(removing) || !navigator.onLine} onClick={() => void remove(file)}><Trash2 className="h-[1rem] w-[1rem]" /></Button></div>
          </li>)}
        </ul>}
        {files.data?.length === 0 && <p className="mt-5 text-sm text-muted-foreground">暂无文件</p>}
      </div>
    </div>
  </Modal>;
}
