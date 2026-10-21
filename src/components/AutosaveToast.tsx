import { Check, CircleAlert } from 'lucide-react';
import { useEffect, useEffectEvent, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Autosave } from '../platform/autosave';
import { renderUiMessage, type UiMessage } from '../platform/i18n/messages';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { useToastManager } from './ui/toast';

type SaveStore = Pick<Autosave<unknown>, 'subscribe' | 'getSnapshot' | 'flush'>;

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
  const { add, close, update } = useToastManager();
  const id = useId();
  const notify = useEffectEvent(
    (phase: 'saving' | 'saved' | 'error', error: UiMessage, refresh = false) => {
      const failed = phase === 'error';
      const toast = {
        id,
        type: phase,
        timeout: phase === 'saved' ? 2500 : 0,
        priority: failed ? ('high' as const) : ('low' as const),
        description: failed
          ? t(($) => $.notSaved, { error: renderUiMessage(error) })
          : phase === 'saving'
            ? t(($) => $.saving)
            : local
              ? t(($) => $.savedLocally)
              : t(($) => $.saved),
        data: {
          testId,
          icon:
            phase === 'saving' ? (
              <Spinner className="mt-0.5 size-4 shrink-0" />
            ) : failed ? (
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
            ),
          actions: failed && (
            <div className="flex flex-wrap gap-1">
              <Button
                variant="secondary"
                type="button"
                onClick={(event) => {
                  // Retry disappears during saving; retain focus on its persistent toast.
                  event.currentTarget.closest<HTMLElement>('[data-slot="toast"]')?.focus({
                    preventScroll: true,
                  });
                  void store.flush().catch(() => {});
                }}
              >
                {t(($) => $.retry)}
              </Button>
              {errorAction}
            </div>
          ),
        },
      };
      if (refresh) update(id, { description: toast.description, data: toast.data });
      else add(toast);
    },
  );
  useEffect(() => {
    let dirty = false;
    const update = () => {
      const { status, error } = store.getSnapshot();
      if (status !== 'saved') dirty = true;
      if (!dirty) return;
      notify(status === 'waiting' ? 'saving' : status, error);
      if (status === 'saved') dirty = false;
    };
    // Observe every transition, including local saves completed in one React batch.
    const unsubscribe = store.subscribe(update);
    update();
    return () => {
      unsubscribe();
      close(id);
    };
  }, [store, close, id]);
  useEffect(() => {
    const { status, error } = store.getSnapshot();
    // Keep contextual actions and translations current without restarting the toast timer.
    notify(status === 'waiting' ? 'saving' : status, error, true);
  }, [store, errorAction, local, t]);
  return null;
}
