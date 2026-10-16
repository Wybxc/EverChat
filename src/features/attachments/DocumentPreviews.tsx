import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { useEffect, useId, useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import type { DocumentPart } from '../../../shared/attachments/documents';
import { attachmentUrl } from '../../../shared/attachments/files';
import { api } from '../../platform/api';

export function DocumentPreviews({ conversationId, files, remove }: { conversationId: string; files: DocumentPart[]; remove?: (id: string) => void }) {
  const [preview, setPreview] = useState<DocumentPart | null>(null), [text, setText] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const title = useId();
  useEffect(() => { setPreview(null); }, [conversationId]);
  useEffect(() => {
    if (!preview) return;
    const abort = new AbortController(); setLoading(true); setText(''); setError('');
    void api<{ file: DocumentPart; text: string }>(`/conversations/${conversationId}/attachments/${preview.attachmentId}/document`, 'GET', undefined, abort.signal)
      .then((saved) => { if (!abort.signal.aborted) setText(saved.text); }, (error) => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : '暂时无法读取文件。'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [preview, conversationId]);
  if (!files.length) return null;
  return <><ul className="mb-2 divide-y divide-border max-w-full rounded-lg border border-border bg-background" aria-label={remove ? '待发送文件' : '消息文件'}>
    {files.map((file) => <li key={file.attachmentId} className="flex items-center gap-2 p-2">
      <FileText className="h-[1rem] w-[1rem]" /><Button variant="ghost" type="button" className="min-w-0 flex-1 justify-start" aria-label={`预览 ${file.name}`} onClick={() => setPreview(file)}><span className="truncate">{file.name}</span></Button>
      {remove && <Button variant="ghost" size="icon" type="button" aria-label={`移除 ${file.name}`} onClick={() => remove(file.attachmentId)}><X className="h-[0.8125rem] w-[0.8125rem]" /></Button>}
    </li>)}
  </ul>{preview && <Modal open onOpenChange={(next) => { if (!next) setPreview(null); }} aria-labelledby={title} onSubmit={(event) => event.stopPropagation()}>
    <div className="w-full flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-4"><ModalTitle id={title} className="min-w-0 flex-1 truncate font-medium">{preview.name}</ModalTitle><Button variant="ghost" size="icon" asChild><a aria-label="下载文件" href={attachmentUrl(conversationId, preview.attachmentId)} download={preview.name}><Download className="h-[1rem] w-[1rem]" /></a></Button><Button variant="ghost" size="icon" type="button" aria-label="关闭文件预览" onClick={() => setPreview(null)}><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>
      <div className="min-h-0 overflow-auto p-4">{loading ? <p role="status">正在读取…</p> : error ? <p role="alert">{error}</p> : <pre className="font-mono text-sm whitespace-pre-wrap break-words">{text}</pre>}</div>
    </div>
  </Modal>}</>;
}
