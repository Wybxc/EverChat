import { useTranslation } from 'react-i18next';
import './locales';
import type { ReactNode, RefObject } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
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
  const { t } = useTranslation('library', { useSuspense: false });

  if (desktop)
    return (
      !collapsed && (
        <aside
          aria-label={t(($) => $.chatList)}
          className="sidebar-surface flex w-65 shrink-0 flex-col"
        >
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
        aria-hidden={!open || undefined}
        inert={!open || undefined}
        className="sidebar-surface data-[side=left]:w-[min(20rem,calc(100dvw-1rem))] gap-0 border-0 p-0"
        finalFocus={() => {
          if (onClosed?.()) return false;
          // A new page or dialog can deliberately claim focus while the sheet closes.
          const active = document.activeElement;
          if (active === document.body || active?.closest('[data-slot="sheet-content"]'))
            return trigger.current;
          return false;
        }}
      >
        <SheetTitle className="sr-only">{t(($) => $.chatList)}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
