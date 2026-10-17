import type { ReactNode, RefObject } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useSidebarSwipe } from './useSidebarSwipe';
export function Sidebar({
  desktop,
  collapsed,
  open,
  onOpenChange,
  trigger,
  children,
  onClosed,
}: {
  desktop: boolean;
  collapsed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  onClosed?: () => boolean;
}) {
  const { preview, dragging } = useSidebarSwipe(desktop, open, onOpenChange);
  if (desktop)
    return (
      !collapsed && (
        <aside aria-label="对话列表" className="sidebar-surface flex w-65 shrink-0 flex-col">
          {children}
        </aside>
      )
    );
  return (
    <Sheet open={open || preview} modal={!preview} onOpenChange={onOpenChange}>
      {preview && (
        <div
          aria-hidden
          className="sidebar-swipe-preview fixed inset-0 z-50 bg-black/40 pointer-events-none"
        />
      )}
      <SheetContent
        side="left"
        showCloseButton={false}
        aria-describedby={undefined}
        data-sidebar-panel=""
        aria-hidden={preview || undefined}
        inert={preview || undefined}
        className="sidebar-surface sidebar-swipe-panel data-[side=left]:w-[min(20rem,calc(100dvw-1rem))] gap-0 border-0 p-0"
        overlayProps={{ className: 'sidebar-swipe-overlay' }}
        onOpenAutoFocus={(event) => {
          if (preview || dragging) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (preview || dragging || onClosed?.()) return;
          // A new page or dialog can deliberately claim focus while the sheet closes.
          const active = document.activeElement;
          if (active === document.body || active?.closest('[data-slot="sheet-content"]'))
            trigger.current?.focus({ preventScroll: true });
        }}
      >
        <SheetTitle className="sr-only">对话列表</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
