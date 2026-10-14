import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { BackupProgress } from './archive-client';

export function BackupProgressDialog({ title, progress, cancel, canRestoreFocus }: {
  title: string; progress: BackupProgress; cancel: () => void; canRestoreFocus: () => boolean;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), button = useRef<HTMLButtonElement>(null), restore = useRef(canRestoreFocus);
  restore.current = canRestoreFocus;
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    element?.showModal(); button.current?.focus();
    return () => {
      const focus = document.activeElement;
      element?.close();
      if (restore.current() && previous instanceof HTMLElement && previous.isConnected && (focus === document.body || element?.contains(focus))) previous.focus();
    };
  }, []);
  return <dialog id={`${id}-dialog`} ref={dialog} className="modal" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <div className="modal-box flex max-h-[85dvh] max-w-md flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 p-5"><h2 id={id} className="text-lg font-semibold">{title}</h2><button ref={button} type="button" className="btn btn-ghost btn-sm btn-square" aria-label={`取消${title}`} onClick={cancel}><X size={18} /></button></div>
      <div className="space-y-3 px-5 pb-5"><p role="status" className="text-sm">{progress.label}</p><progress className="progress" aria-label={title} value={progress.value} max={100} /></div>
      <form method="dialog" className="modal-action m-0 border-t border-base-content/20 p-5" onSubmit={(event) => { event.preventDefault(); cancel(); }}><button type="submit" className="btn">取消</button></form>
    </div>
  </dialog>;
}
