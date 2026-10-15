import { useId, useRef, type ReactNode, type RefObject } from 'react';

/** Native popovers escape scroll containers and restore focus before invoking an action. */
export function ActionMenu({ label, icon, children, className = 'btn btn-ghost btn-square h-11 w-11 shrink-0', placement = 'dropdown-end', menuRef, disabled = false }: {
  label: string; icon: ReactNode; children: ReactNode; className?: string; placement?: string;
  menuRef?: RefObject<HTMLUListElement | null>; disabled?: boolean;
}) {
  const id = useId(), anchor = `--menu-${id.replace(/[^a-z0-9_-]/gi, '')}`;
  const local = useRef<HTMLUListElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menu = menuRef ?? local;
  return <>
    <button ref={trigger} type="button" className={className} aria-label={label} title={label} aria-haspopup="true" popoverTarget={id} style={{ anchorName: anchor }} disabled={disabled} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); menu.current?.showPopover();
        const items = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        (event.key === 'ArrowUp' ? items?.[items.length - 1] : items?.[0])?.focus();
      }
    }}>{icon}</button>
    <ul ref={menu} id={id} popover="auto" aria-label={label} style={{ positionAnchor: anchor }} className={`action-menu dropdown ${placement} menu w-60 max-w-[calc(100vw-1rem)] rounded-box border border-base-300 bg-base-100 p-2 shadow-lg`} onClickCapture={(event) => {
      if ((event.target as Element).closest('button:not(:disabled)')) {
        menu.current?.hidePopover(); trigger.current?.focus({ preventScroll: true });
      }
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []).filter((item) => item.checkVisibility());
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next]?.focus();
    }}>{children}</ul>
  </>;
}
