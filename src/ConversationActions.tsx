import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { Archive, ArchiveRestore, Copy, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ConversationInfo } from '../shared/types';

export function ConversationActions({ conversation, disabled, update, remove, duplicate }: {
  conversation: ConversationInfo; disabled: boolean;
  update: (patch: { title?: string; pinned?: boolean; archived?: boolean }) => Promise<void>;
  remove: () => Promise<void>; duplicate: () => Promise<void>;
}) {
  const menuId = useId(), anchor = `--conversation-${menuId.replace(/[^a-z0-9_-]/gi, '')}`;
  const menu = useRef<HTMLUListElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null);
  const [title, setTitle] = useState(conversation.title), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!mode) return;
    dialog.current?.showModal();
    if (mode === 'rename') { titleInput.current?.focus(); titleInput.current?.select(); }
    else cancelButton.current?.focus();
  }, [mode]);
  const open = (next: 'rename' | 'delete') => {
    menu.current?.hidePopover(); setError(''); setTitle(conversation.title); setMode(next);
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    menu.current?.hidePopover(); setError(''); setBusy(true);
    try { await action(); dialog.current?.close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '修改失败，请重试。'); if (!mode) menu.current?.showPopover(); }
    finally { setBusy(false); }
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === 'rename' && title.trim()) void perform(() => update({ title: title.trim() }));
    if (mode === 'delete') void perform(remove);
  };
  return <>
    <button type="button" className="btn btn-ghost btn-sm btn-square" aria-label="管理对话" title="管理对话" popoverTarget={menuId} style={{ anchorName: anchor }} disabled={disabled || busy}><MoreHorizontal size={18} /></button>
    <ul id={menuId} ref={menu} popover="auto" style={{ positionAnchor: anchor }} className="dropdown dropdown-end menu z-50 w-44 rounded-box border border-base-content/30 bg-base-100 p-2 shadow-lg">
      <li><button disabled={disabled || busy} onClick={() => open('rename')}><Pencil size={15} />重命名</button></li>
      <li><button disabled={disabled || busy} onClick={() => void perform(() => update({ pinned: !conversation.pinned }))}>{conversation.pinned ? <PinOff size={15} /> : <Pin size={15} />}{conversation.pinned ? '取消置顶' : '置顶'}</button></li>
      <li><button disabled={disabled || busy} onClick={() => void perform(() => update({ archived: !conversation.archived }))}>{conversation.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{conversation.archived ? '取消归档' : '归档'}</button></li>
      <li><button disabled={disabled || busy} onClick={() => void perform(duplicate)}><Copy size={15} />复制对话</button></li>
      <li><button disabled={disabled || busy} onClick={() => open('delete')}><Trash2 size={15} />删除</button></li>
      {error && !mode && <li><span role="alert" className="whitespace-normal text-xs">{error}</span></li>}
    </ul>
    <dialog ref={dialog} className="modal" aria-labelledby={`${menuId}-title`} onClose={() => setMode(null)} onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <div className="modal-box max-w-md">
        <h2 id={`${menuId}-title`} className="text-lg font-semibold">{mode === 'delete' ? '删除对话' : '重命名'}</h2>
        <form onSubmit={submit}>
          {mode === 'rename' ? <label className="mt-5 block text-sm">对话名称<input ref={titleInput} className="input mt-2 w-full" required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
            : <p className="mt-4 break-words text-sm leading-6">删除“{conversation.title}”后无法恢复，正在生成的回答也会停止。</p>}
          {error && <div role="alert" className="alert alert-error mt-4 text-sm">{error}</div>}
          <div className="modal-action"><button ref={cancelButton} type="button" className="btn" onClick={() => dialog.current?.close()} disabled={busy}>取消</button><button type="submit" className={`btn ${mode === 'delete' ? 'btn-error' : ''}`} disabled={disabled || busy || (mode === 'rename' && !title.trim())}>{busy ? <span className="loading loading-spinner loading-xs" /> : mode === 'delete' ? '删除' : '保存'}</button></div>
        </form>
      </div>
      <form method="dialog" className="modal-backdrop"><button disabled={busy}>关闭</button></form>
    </dialog>
  </>;
}
