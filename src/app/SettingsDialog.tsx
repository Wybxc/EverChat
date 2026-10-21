import { useTranslation } from 'react-i18next';
import './locales';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal, ModalTitle } from '../components/Modal';

export function SettingsDialog({
  open,
  close,
  children,
  restoreFocus = true,
}: {
  open: boolean;
  close: () => void;
  children: ReactNode;
  restoreFocus?: boolean;
}) {
  const { t } = useTranslation('app', { useSuspense: false });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      finalFocus={restoreFocus ? undefined : false}
      aria-labelledby="space-settings-title"
    >
      <div className="settings-dialog flex h-[min(48rem,92dvh)] max-h-[92dvh] max-w-[60rem] flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between px-3 py-1.5 sm:px-4">
          <ModalTitle id="space-settings-title" className="text-lg font-semibold">
            {t(($) => $.settings)}
          </ModalTitle>
          <Button
            type="button"
            onClick={close}
            variant="ghost"
            size="icon"
            aria-label={t(($) => $.closeSettings)}
          >
            <X className="size-[1.125rem]" />
          </Button>
        </div>
        {children}
      </div>
    </Modal>
  );
}
