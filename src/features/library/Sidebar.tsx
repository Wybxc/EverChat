import type { ReactNode, RefObject } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
export function Sidebar({
  desktop,
  collapsed,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  desktop: boolean;
  collapsed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  if (desktop)
    return (
      !collapsed && (
        <aside aria-label="对话列表" className="sidebar-surface flex w-65 shrink-0 flex-col">
          {children}
        </aside>
      )
    );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        aria-describedby={undefined}
        className="sidebar-surface data-[side=left]:w-[min(20rem,calc(100dvw-1rem))] gap-0 border-0 p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
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
