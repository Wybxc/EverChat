import { Check, CircleAlert, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Autosave } from '../platform/autosave';
import { renderUiMessage, type UiMessage } from '../platform/i18n/messages';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { Toast, ToastClose, ToastDescription } from './ui/toast';

type SaveStore = Pick<Autosave<unknown>, 'subscribe' | 'getSnapshot' | 'flush'>;
type Notice = {
  phase: 'saving' | 'saved' | 'error';
  error: UiMessage;
  open: boolean;
  version: number;
};

export function AutosaveToast({
  store,
  local = false,
  testId,
  errorAction,
}: {
  store: SaveStore;
  local?: boolean;
  testId: string;
  errorAction?: ReactNode;
}) {
  const { t } = useTranslation('common');
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    let dirty = false;
    const update = () => {
      const { status, error } = store.getSnapshot();
      if (status !== 'saved') dirty = true;
      if (!dirty) return;
      const phase = status === 'waiting' ? 'saving' : status;
      setNotice((previous) => ({
        phase,
        error,
        open: true,
        version: (previous?.version ?? 0) + (previous?.phase === phase ? 0 : 1),
      }));
      if (status === 'saved') dirty = false;
    };
    // Observe every transition, including local saves that complete in one React batch.
    const unsubscribe = store.subscribe(update);
    update();
    return unsubscribe;
  }, [store]);
  if (!notice) return null;
  const failed = notice.phase === 'error';
  return (
    <Toast
      key={notice.version}
      open={notice.open}
      onOpenChange={(open) => setNotice((current) => (current ? { ...current, open } : null))}
      duration={notice.phase === 'saved' ? 2500 : Infinity}
      type={failed ? 'foreground' : 'background'}
    >
      {notice.phase === 'saving' ? (
        <Spinner className="mt-0.5 size-4 shrink-0" />
      ) : failed ? (
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <ToastDescription
          data-testid={testId}
          role={failed ? 'alert' : 'status'}
          aria-live="off"
          className="break-words"
        >
          {failed
            ? t(($) => $.notSaved, { error: renderUiMessage(notice.error) })
            : notice.phase === 'saving'
              ? t(($) => $.saving)
              : local
                ? t(($) => $.savedLocally)
                : t(($) => $.saved)}
        </ToastDescription>
        {failed && (
          <div className="flex flex-wrap gap-1">
            <Button
              variant="secondary"
              type="button"
              onClick={() => void store.flush().catch(() => {})}
            >
              {t(($) => $.retry)}
            </Button>
            {errorAction}
          </div>
        )}
      </div>
      <ToastClose asChild>
        <Button variant="ghost" size="icon" type="button" aria-label={t(($) => $.close)}>
          <X className="size-4" />
        </Button>
      </ToastClose>
    </Toast>
  );
}
