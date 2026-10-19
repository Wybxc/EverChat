import { useTranslation } from 'react-i18next';
import { notificationMessage } from './locales';
import { useSyncExternalStore } from 'react';
import { Bell, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { NotificationMode } from '../../../shared/notifications/protocol';
import {
  enableNotifications,
  notificationSnapshot,
  setNotificationMode,
  subscribeNotifications,
  testNotification,
} from '../../platform/notifications/controller';

export function NotificationSettings() {
  const { t } = useTranslation('notifications', { useSuspense: false });

  const state = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  return (
    <section aria-label={t(($) => $.title)} className="space-y-2">
      <label className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
        <span>{t(($) => $.completion)}</span>
        <NativeSelect
          aria-label={t(($) => $.completion)}
          value={state.mode}
          className="w-full sm:w-64"
          onChange={(event) => void setNotificationMode(event.target.value as NotificationMode)}
        >
          <option value="always">{t(($) => $.always)}</option>
          <option value="never">{t(($) => $.never)}</option>
          <option value="unfocused">{t(($) => $.unfocused)}</option>
        </NativeSelect>
      </label>
      {state.mode === 'unfocused' && (
        <p className="text-xs text-muted-foreground">{t(($) => $.foregroundHint)}</p>
      )}
      <p role="status" className="text-xs text-muted-foreground">
        {state.mode === 'never'
          ? state.pending
            ? t(($) => $.disablePending)
            : t(($) => $.disabled)
          : state.permission === 'unsupported'
            ? t(($) => $.unsupported)
            : state.permission === 'denied'
              ? t(($) => $.denied)
              : !state.enabled
                ? t(($) => $.notEnabled)
                : state.pending
                  ? t(($) => $.pending)
                  : state.ready === 'push'
                    ? t(($) => $.pushReady)
                    : state.ready === 'local'
                      ? t(($) => $.localReady)
                      : t(($) => $.notReady)}
      </p>
      {state.mode !== 'never' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            type="button"
            disabled={
              state.busy || state.permission === 'denied' || state.permission === 'unsupported'
            }
            onClick={() => void enableNotifications()}
          >
            <Bell className="size-4" />
            {state.ready === 'push' ? t(($) => $.recheck) : t(($) => $.enable)}
          </Button>
          {state.enabled && state.permission === 'granted' && (
            <Button
              variant="ghost"
              type="button"
              disabled={state.busy}
              onClick={() => void testNotification()}
            >
              <Send className="size-4" />
              {t(($) => $.test)}
            </Button>
          )}
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {notificationMessage(state.error)}
        </p>
      )}
    </section>
  );
}
