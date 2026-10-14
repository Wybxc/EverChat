import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { Message } from '../shared/types';

export function MessageMutationDialog({ message, mode, confirm, close }: {
  message: Message; mode: 'edit' | 'delete'; confirm: (content: string, requestId: string) => Promise<void>; close: () => void;
}) {
  const titleId = useId(), dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLTextAreaElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState(message.content), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef({ id: crypto.randomUUID(), content: message.content.trim() });
  useEffect(() => {
    dialog.current?.showModal();
    if (mode === 'edit') input.current?.focus(); else cancel.current?.focus();
  }, [mode]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (mode === 'edit' && !content.trim())) return;
    if (request.current.content !== content.trim()) request.current = { id: crypto.randomUUID(), content: content.trim() };
    setError(''); setBusy(true);
    try { await confirm(content, request.current.id); dialog.current?.close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onClose={close} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="modal-box flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold">{mode === 'edit' ? '编辑回答' : '删除消息'}</h2>
        <form method="dialog"><button type="submit" className="btn btn-ghost btn-sm btn-square" aria-label="关闭消息操作" disabled={busy}><X size={18} /></button></form>
      </div>
      <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
        {mode === 'edit' ? <textarea ref={input} aria-label="回答内容" className="textarea h-72 min-h-32 w-full shrink overflow-y-auto" maxLength={100000} value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} /> : <p>删除这条消息？</p>}
        {error && <p role="alert" className="mt-3 shrink-0 text-sm">{error}</p>}
        <div className="modal-action shrink-0">
          <button ref={cancel} type="button" className="btn" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" className={`btn ${mode === 'delete' ? 'btn-error' : ''}`} disabled={busy || (mode === 'edit' && !content.trim())}>{busy && <span className="loading loading-spinner loading-xs" />}{mode === 'edit' ? '保存新版本' : '确认删除'}</button>
        </div>
      </form>
    </div>
  </dialog>;
}
