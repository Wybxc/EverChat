import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';

export type SaveToastData = {
  icon: ReactNode;
  testId: string;
  actions?: ReactNode;
};
export const useToastManager = () => ToastPrimitive.useToastManager<SaveToastData>();

/** Keep notifications and retry actions inside the active dialog's accessibility boundary. */
export function ToastRegion({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider>
      {children}
      <SaveToastViewport />
    </ToastPrimitive.Provider>
  );
}

function SaveToastViewport() {
  const { t } = useTranslation('common');
  const { toasts } = useToastManager();
  return (
    <ToastPrimitive.Viewport
      aria-label={t(($) => $.saveNotification)}
      className="pointer-events-none absolute right-3 bottom-3 z-50 m-0 flex max-h-[min(24rem,70dvh)] w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2 outline-none"
    >
      {toasts.map((toast) => (
        <ToastPrimitive.Root
          key={toast.id}
          toast={toast}
          data-slot="toast"
          className="pointer-events-auto overflow-y-auto rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring data-limited:hidden motion-safe:transition-[opacity,transform] motion-safe:duration-150 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0"
        >
          <ToastPrimitive.Content className="flex items-start gap-2">
            {toast.data?.icon}
            <div className="min-w-0 flex-1 space-y-1">
              <ToastPrimitive.Description
                data-testid={toast.data?.testId}
                className="break-words"
              />
              {toast.data?.actions}
            </div>
            <ToastPrimitive.Close
              render={<Button variant="ghost" size="icon" type="button" />}
              aria-label={t(($) => $.close)}
            >
              <X className="size-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Content>
        </ToastPrimitive.Root>
      ))}
    </ToastPrimitive.Viewport>
  );
}
