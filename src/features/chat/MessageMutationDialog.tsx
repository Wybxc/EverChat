import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { messageText } from '../../../shared/conversation/content';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { X } from 'lucide-react';
import type { Message } from '../../../shared/conversation/types';

export function MessageMutationDialog({ message, mode, affectsSummaries = false, confirm, close, restoreCompletedFocus }: {
  message: Message; mode: 'edit' | 'delete'; affectsSummaries?: boolean; confirm: (content: string, requestId: string) => Promise<void>; close: () => void; restoreCompletedFocus?: () => void;
}) {
  const titleId = useId(), input = useRef<HTMLTextAreaElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState(messageText(message)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef({ id: crypto.randomUUID(), content: messageText(message).trim() });
  const confirmed = useRef(false);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || (mode === 'edit' && !content.trim())) return;
    if (request.current.content !== content.trim()) request.current = { id: crypto.randomUUID(), content: content.trim() };
    setError(''); setBusy(true);
    try { await confirm(content, request.current.id); confirmed.current = true; close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <Modal open onOpenChange={(next) => { if (!next) close(); }} alert={mode === 'delete'} busy={busy} initialFocus={mode === 'edit' ? input : cancel} aria-labelledby={titleId}
    onCloseAutoFocus={(event) => { if (confirmed.current && restoreCompletedFocus) { event.preventDefault(); restoreCompletedFocus(); } }}>
    <div className="p-5 flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
        <ModalTitle id={titleId} className="text-lg font-semibold">{mode === 'edit' ? '编辑回答' : message.summary ? '删除摘要' : '删除消息'}</ModalTitle>
        <div><Button variant="ghost" size="icon" type="button" onClick={close} aria-label="关闭消息操作" disabled={busy}><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>
      </div>
      <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
        {mode === 'edit' ? <Textarea ref={input} aria-label="回答内容" className="h-72 min-h-32 w-full shrink overflow-y-auto" maxLength={100000} value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} /> : <p>{message.summary ? '删除摘要？原始消息仍保留。' : affectsSummaries ? '删除这条消息？覆盖它的历史摘要也会清除。' : '删除这条消息？'}</p>}
        {error && <p role="alert" className="mt-3 shrink-0 text-sm">{error}</p>}
        <div className="dialog-actions shrink-0">
          <Button variant="secondary" ref={cancel} type="button" disabled={busy} onClick={() => close()}>取消</Button>
          <Button variant={mode === 'delete' ? 'destructive' : 'default'} type="submit" disabled={busy || (mode === 'edit' && !content.trim())}>{busy && <Spinner />}{mode === 'edit' ? '保存新版本' : '确认删除'}</Button>
        </div>
      </form>
    </div>
  </Modal>;
}
