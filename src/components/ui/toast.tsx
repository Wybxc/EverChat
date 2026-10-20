import { Toast as ToastPrimitive } from 'radix-ui';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Keep announcements and actions inside the active dialog's accessibility boundary. */
export function ToastRegion({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setContainer} className="contents">
      <ToastPrimitive.Provider
        label={t(($) => $.saveNotification)}
        announcerContainer={container ?? undefined}
      >
        {children}
        <ToastPrimitive.Viewport
          label={t(($) => $.saveNotificationsShortcut)}
          className="pointer-events-none absolute right-3 bottom-3 z-50 m-0 flex max-h-[min(24rem,70dvh)] w-[min(24rem,calc(100%-1.5rem))] list-none flex-col gap-2 outline-none"
        />
      </ToastPrimitive.Provider>
    </div>
  );
}

export function Toast({ className, ...props }: ComponentProps<typeof ToastPrimitive.Root>) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        'pointer-events-auto flex items-start gap-2 overflow-y-auto rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring data-[swipe=end]:hidden motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  );
}

export const ToastDescription = ToastPrimitive.Description;
export const ToastClose = ToastPrimitive.Close;
