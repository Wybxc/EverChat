import { useTranslation } from 'react-i18next';
import './locales';
import { useId, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Modal, ModalTitle } from '../../components/Modal';
import type { BackupProgress } from './archive-client';

export function BackupProgressDialog({
  title,
  progress,
  cancel,
  canRestoreFocus,
}: {
  title: 'download' | 'import';
  progress: BackupProgress;
  cancel: () => void;
  canRestoreFocus: () => boolean;
}) {
  const { t } = useTranslation('backup', { useSuspense: false });

  const id = useId(),
    button = useRef<HTMLButtonElement>(null),
    previous = useRef(document.activeElement);
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      initialFocus={button}
      aria-labelledby={id}
      finalFocus={() => {
        const target = previous.current;
        if (
          canRestoreFocus() &&
          target instanceof HTMLElement &&
          target.isConnected &&
          target.checkVisibility() &&
          !target.closest('[inert]')
        )
          return target;
        return false;
      }}
    >
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between gap-3 p-5">
          <ModalTitle id={id} className="text-lg font-semibold">
            {t(($) => $[title])}
          </ModalTitle>
          <Button
            ref={button}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(($) => $.cancelTask, { title: t(($) => $[title]) })}
            onClick={cancel}
          >
            <X />
          </Button>
        </div>
        <div className="space-y-3 px-5 pb-5">
          <p role="status" className="text-sm">
            {t(($) => $[progress.label])}
          </p>
          <Progress aria-label={t(($) => $[title])} value={progress.value} />
        </div>
        <div className="flex justify-end p-5 pt-0">
          <Button type="button" variant="secondary" onClick={cancel}>
            {t(($) => $.cancel)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
