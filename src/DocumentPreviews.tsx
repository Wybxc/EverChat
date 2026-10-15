import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, X } from 'lucide-react';
import type { DocumentPart } from '../shared/documents';
import { attachmentUrl } from '../shared/attachments';
import { api } from './api';

export function DocumentPreviews({ conversationId, files, remove }: { conversationId: string; files: DocumentPart[]; remove?: (id: string) => void }) {
  const [preview, setPreview] = useState<DocumentPart | null>(null), [text, setText] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => { setPreview(null); }, [conversationId]);
  useEffect(() => {
    if (!preview) return;
    const abort = new AbortController(); dialog.current?.showModal(); setLoading(true); setText(''); setError('');
    void api<{ file: DocumentPart; text: string }>(`/conversations/${conversationId}/attachments/${preview.attachmentId}/document`, 'GET', undefined, abort.signal)
      .then((saved) => { if (!abort.signal.aborted) setText(saved.text); }, (error) => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : '暂时无法读取文件。'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [preview, conversationId]);
  if (!files.length) return null;
  return <><ul className="list mb-2 max-w-full rounded-box border border-base-300 bg-base-100" aria-label={remove ? '待发送文件' : '消息文件'}>
    {files.map((file) => <li key={file.attachmentId} className="list-row items-center gap-2 p-2">
      <FileText size={16} /><button type="button" className="btn btn-ghost btn-sm min-w-0 justify-start" aria-label={`预览 ${file.name}`} onClick={() => setPreview(file)}><span className="truncate">{file.name}</span></button>
      {remove && <button type="button" className="btn btn-ghost btn-square btn-xs" aria-label={`移除 ${file.name}`} onClick={() => remove(file.attachmentId)}><X size={13} /></button>}
    </li>)}
  </ul>{preview && createPortal(<dialog id={`${title}-dialog`} ref={dialog} className="modal" aria-labelledby={title} onSubmit={(event) => event.stopPropagation()} onClose={() => setPreview(null)}>
    <div className="modal-box flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-content/30 p-4"><h2 id={title} className="min-w-0 flex-1 truncate font-medium">{preview.name}</h2><a className="btn btn-ghost btn-square btn-sm" aria-label="下载文件" href={attachmentUrl(conversationId, preview.attachmentId)} download={preview.name}><Download size={16} /></a><button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="关闭文件预览" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <div className="min-h-0 overflow-auto p-4">{loading ? <p role="status">正在读取…</p> : error ? <p role="alert">{error}</p> : <pre className="font-mono text-sm whitespace-pre-wrap break-words">{text}</pre>}</div>
    </div><form method="dialog" className="modal-backdrop"><button>关闭</button></form>
  </dialog>, document.body)}</>;
}
