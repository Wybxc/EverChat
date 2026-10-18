import { clear, createStore, get, update } from 'idb-keyval';
import type { NotificationMode } from '../../../shared/notifications/protocol';

const store = createStore('everchat-notifications', 'state');
export interface NotificationPreference {
  instanceId: string;
  owner: string | null;
  mode: NotificationMode;
  enabled: boolean;
  revision: number;
  syncedRevision: number;
  push: boolean;
}
const initial = (): NotificationPreference => ({
  instanceId: crypto.randomUUID(),
  owner: null,
  mode: 'unfocused',
  enabled: false,
  revision: Date.now(),
  syncedRevision: 0,
  push: false,
});
export async function notificationPreference() {
  let result!: NotificationPreference;
  await update<NotificationPreference>(
    'preference',
    (value) => (result = value ?? initial()),
    store,
  );
  return result;
}
export async function changeNotificationPreference(
  patch: Partial<Pick<NotificationPreference, 'owner' | 'mode' | 'enabled' | 'push'>>,
) {
  let result!: NotificationPreference;
  await update<NotificationPreference>(
    'preference',
    (value) => {
      const old = value ?? initial();
      return (result = { ...old, ...patch, revision: Math.max(Date.now(), old.revision + 1) });
    },
    store,
  );
  return result;
}
export async function acknowledgeNotificationPreference(revision: number, push: boolean) {
  await update<NotificationPreference | undefined>(
    'preference',
    (value) =>
      value?.revision === revision ? { ...value, syncedRevision: revision, push } : value,
    store,
  );
}
export const readNotificationPreference = () => get<NotificationPreference>('preference', store);
export async function claimLocalNotification(id: string, expires: number) {
  let claimed = false;
  await update<Record<string, number>>(
    'claims',
    (value) => {
      const claims = Object.fromEntries(
        Object.entries(value ?? {}).filter(([, until]) => until > Date.now()),
      );
      if (!claims[id]) {
        claims[id] = expires;
        claimed = true;
      }
      return claims;
    },
    store,
  );
  return claimed;
}
export async function clearNotificationStorage() {
  await clear(store);
}
