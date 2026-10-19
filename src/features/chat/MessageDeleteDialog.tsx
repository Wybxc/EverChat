import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { X } from 'lucide-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '../../../shared/conversation/types';
import { Modal, ModalTitle } from '../../components/Modal';
import {
  errorMessage,
  renderUiMessage,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import './locales';

export function MessageDeleteDialog({
  message,
  affectsSummaries = false,
  confirm,
  close,
  restoreCompletedFocus,
}: {
  message: Message;
  affectsSummaries?: boolean;
  confirm: () => Promise<void>;
  close: () => void;
  restoreCompletedFocus?: () => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const titleId = useId(),
    cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<UiMessage>('');
  const confirmed = useRef(false);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await confirm();
      confirmed.current = true;
      close();
    } catch (cause) {
      setError(errorMessage(cause, uiMessage('chat', 'operationFailed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      alert
      busy={busy}
      initialFocus={cancel}
      aria-labelledby={titleId}
      onCloseAutoFocus={(event) => {
        if (confirmed.current && restoreCompletedFocus) {
          event.preventDefault();
          restoreCompletedFocus();
        }
      }}
    >
      <div className="p-5 flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
        <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
          <ModalTitle id={titleId} className="text-lg font-semibold">
            {message.summary ? t(($) => $.deleteSummary) : t(($) => $.deleteMessage)}
          </ModalTitle>
          <div>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={close}
              aria-label={t(($) => $.closeMessageActions)}
              disabled={busy}
            >
              <X className="h-[1.125rem] w-[1.125rem]" />
            </Button>
          </div>
        </div>
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <p>
            {message.summary
              ? t(($) => $.confirmDeleteSummary)
              : affectsSummaries
                ? t(($) => $.confirmDeleteCoveredMessage)
                : t(($) => $.confirmDeleteMessage)}
          </p>
          {error && (
            <p role="alert" className="mt-3 shrink-0 text-sm">
              {renderUiMessage(error)}
            </p>
          )}
          <div className="dialog-actions shrink-0">
            <Button
              variant="secondary"
              ref={cancel}
              type="button"
              disabled={busy}
              onClick={() => close()}
            >
              {t(($) => $.cancel)}
            </Button>
            <Button variant="destructive" type="submit" disabled={busy}>
              {busy && <Spinner />}
              {t(($) => $.confirmDelete)}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
