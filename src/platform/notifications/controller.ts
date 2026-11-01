import { mirrorNotificationLocale } from './locale';
import type notificationLabels from '../../features/notifications/locales/en';
import { registerNotificationCleanup } from '../storage';
import { clearNotificationLocal } from './cleanup';
import * as v from 'valibot';
import {
  completionSchema,
  NOTIFICATION_CHANNEL,
  type NotificationDevice,
  type NotificationMode,
} from '../../../shared/notifications/protocol';
import { identityKey } from '../../../shared/auth/types';
import { api } from '../api';
import { serializePushSubscription, InvalidPushSubscriptionError } from './subscription';
import { networkIdentity } from '../auth';
import { onControlPacket, sendControl, startControl, stopControl } from '../sync/control';
import {
  acknowledgeNotificationPreference,
  changeNotificationPreference,
  notificationPreference,
  type NotificationPreference,
} from './store';

registerNotificationCleanup(clearNotificationLocal);
class NotificationError extends Error {
  constructor(readonly key: Exclude<NotificationState['error'], ''>) {
    super(key);
  }
}

export interface NotificationState {
  mode: NotificationMode;
  permission: NotificationPermission | 'unsupported';
  enabled: boolean;
  ready: 'none' | 'local' | 'push';
  pending: boolean;
  busy: boolean;
  error: keyof typeof notificationLabels | '';
  diagnostic?: string;
}
let state: NotificationState = {
  mode: 'unfocused',
  permission: 'unsupported',
  enabled: false,
  ready: 'none',
  pending: false,
  busy: false,
  error: '',
};
const listeners = new Set<() => void>();
export const subscribeNotifications = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const notificationSnapshot = () => state;
const emit = (patch: Partial<NotificationState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const permission = () =>
  typeof Notification === 'undefined' || !isSecureContext
    ? ('unsupported' as const)
    : Notification.permission;
let owner: string | null = null;
let channel: BroadcastChannel | null = null;
let stopped = true,
  generation = 0;
let syncing: Promise<void> | null = null;
let navigating: ((conversationId: string, messageId: string) => void) | null = null;
const registration = async () => {
  if (!('serviceWorker' in navigator)) throw new NotificationError('unsupportedError');
  const value = await navigator.serviceWorker.getRegistration('/');
  if (!value?.active) throw new NotificationError('registrationNotReady');
  return value;
};
const authorized = () => {
  const identity = networkIdentity();
  return owner && identity && owner === identityKey(identity);
};
const broadcast = () => channel?.postMessage('changed');
const fail = (error: unknown) =>
  emit({
    error:
      error instanceof NotificationError
        ? error.key
        : error instanceof InvalidPushSubscriptionError
          ? 'invalidSubscription'
          : 'settingsFailed',
    diagnostic: error instanceof Error ? error.message : undefined,
  });
async function refresh() {
  const value = await notificationPreference();
  emit({
    mode: value.mode,
    permission: permission(),
    enabled: value.enabled,
    ready:
      value.enabled && value.owner === owner && value.syncedRevision === value.revision
        ? value.push
          ? 'push'
          : 'local'
        : 'none',
    pending: Boolean(value.owner) && value.syncedRevision !== value.revision,
  });
  return value;
}
const closeSocket = stopControl;
function connect(value: NotificationPreference) {
  if (stopped || !authorized() || !navigator.onLine) {
    closeSocket();
    return;
  }
  startControl(owner!, value.instanceId);
}
const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
    character.charCodeAt(0),
  );
async function synchronizeNow() {
  let value = await refresh();
  if (!authorized() || !navigator.onLine) {
    closeSocket();
    return;
  }
  // Presence belongs to the signed-in page, independently of notification permission.
  connect(value);
  if (value.owner !== owner) return;
  const expectedOwner = owner,
    current = generation;
  let subscription: PushSubscription | null = null;
  let subscriptionChanged = false;
  let reason: NotificationState['error'] = '';
  if (value.enabled && value.mode !== 'never' && permission() === 'granted') {
    const reg = await registration();
    const config = await api<{ publicKey: string | null }>('/notifications/config');
    if (config.publicKey && 'PushManager' in window && reg.pushManager) {
      try {
        subscription = await reg.pushManager.getSubscription();
        const publicKey = keyBytes(config.publicKey);
        if (
          subscription &&
          ((subscription.expirationTime !== null && subscription.expirationTime <= Date.now()) ||
            !subscription.options.applicationServerKey ||
            String(new Uint8Array(subscription.options.applicationServerKey)) !== String(publicKey))
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
        if (!subscription) {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: publicKey,
          });
          subscriptionChanged = true;
        }
      } catch {
        reason = 'pushFailed';
      }
    } else reason = 'localOnly';
  } else {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    await reg?.pushManager
      ?.getSubscription()
      .then((sub) => sub?.unsubscribe())
      .catch(() => {});
  }
  if (stopped || current !== generation || expectedOwner !== owner) return;
  const latest = await notificationPreference();
  if (latest.revision !== value.revision) return synchronizeNow();
  if (value.push !== Boolean(subscription) || subscriptionChanged) {
    value = await changeNotificationPreference({ push: Boolean(subscription) });
    await refresh();
  }
  const input: NotificationDevice = {
    instanceId: value.instanceId,
    revision: value.revision,
    mode: value.enabled && permission() === 'granted' ? value.mode : 'never',
    subscription: subscription ? serializePushSubscription(subscription) : null,
  };
  if (value.syncedRevision === value.revision) {
    // Connection/focus recovery is not a notification settings write.
    emit({ error: reason });
    return;
  }
  const saved = await api<NotificationDevice>('/notifications/device', 'PUT', input);
  if (stopped || current !== generation) return;
  if (
    saved.revision === value.revision &&
    Boolean(saved.subscription) !== Boolean(input.subscription)
  ) {
    // An expired gateway subscription may have been invalidated by the server.
    await subscription?.unsubscribe();
    await changeNotificationPreference({ push: false });
    return synchronizeNow();
  }
  await acknowledgeNotificationPreference(value.revision, Boolean(saved.subscription));
  value = await refresh();
  if (value.syncedRevision !== value.revision) return synchronizeNow();
  emit({ error: reason });
  broadcast();
  connect(value);
}
function synchronize() {
  if (syncing) return syncing;
  const current = generation;
  const task = synchronizeNow()
    .catch(fail)
    .finally(() => {
      if (syncing === task) syncing = null;
      if (!stopped && current !== generation) void synchronize();
    });
  syncing = task;
  return task;
}
export function startNotifications(
  identity: string | null,
  navigate: (conversationId: string, messageId: string) => void,
) {
  mirrorNotificationLocale();
  stopped = false;
  owner = identity;
  navigating = navigate;
  generation++;
  channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NOTIFICATION_CHANNEL);
  if (channel) channel.onmessage = () => void refresh().then(connect).catch(fail);
  const stopPackets = onControlPacket((packet) => {
    if (stopped || !authorized()) return;
    if (packet.type === 'check')
      sendControl(
        JSON.stringify({
          type: 'check',
          id: packet.id,
          foreground: document.visibilityState === 'visible' && document.hasFocus(),
        }),
      );
    if (packet.type === 'local')
      void registration()
        .then((reg) => reg.active?.postMessage({ channel: NOTIFICATION_CHANNEL, ...packet }))
        .catch(fail);
  });
  const resume = () => {
    void (async () => {
      const value = await refresh();
      if (value.enabled && permission() !== 'granted') {
        await changeNotificationPreference({ enabled: false, push: false });
        broadcast();
      }
      await synchronize();
    })().catch(fail);
  };
  const offline = () => closeSocket();
  const message = (event: MessageEvent) => {
    if (event.data?.channel !== NOTIFICATION_CHANNEL || event.data.type !== 'navigate') return;
    const completion = v.safeParse(completionSchema, event.data.completion);
    if (completion.success)
      navigating?.(completion.output.conversationId, completion.output.messageId);
  };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  window.addEventListener('offline', offline);
  window.addEventListener('everchat:network-ready', resume);
  navigator.serviceWorker?.addEventListener('message', message);
  navigator.serviceWorker?.addEventListener('controllerchange', resume);
  void (async () => {
    const value = await notificationPreference();
    if (identity && value.owner && value.owner !== identity) await clearNotificationLocal();
    resume();
  })().catch(fail);
  return () => {
    stopped = true;
    generation++;
    closeSocket();
    stopPackets();
    channel?.close();
    channel = null;
    navigating = null;
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('offline', offline);
    window.removeEventListener('everchat:network-ready', resume);
    navigator.serviceWorker?.removeEventListener('message', message);
    navigator.serviceWorker?.removeEventListener('controllerchange', resume);
  };
}
export async function setNotificationMode(mode: NotificationMode) {
  try {
    await changeNotificationPreference({ mode });
    closeSocket();
    await refresh();
    broadcast();
    await synchronize();
  } catch (error) {
    fail(error);
  }
}
export async function enableNotifications() {
  if (!owner || !authorized()) {
    fail(new NotificationError('signInFirst'));
    return;
  }
  if (permission() === 'unsupported') {
    fail(new NotificationError('installFirst'));
    return;
  }
  // Keep permission request in the original click gesture, before any asynchronous work.
  const expectedOwner = owner,
    expectedGeneration = generation;
  emit({ busy: true, error: '' });
  try {
    const result = Notification.requestPermission();
    if ((await result) !== 'granted') throw new NotificationError('permissionRequired');
    if (stopped || owner !== expectedOwner || generation !== expectedGeneration) return;
    await registration();
    await changeNotificationPreference({ owner, enabled: true });
    await refresh();
    broadcast();
    await synchronize();
  } catch (error) {
    fail(error);
  } finally {
    emit({ permission: permission(), busy: false });
  }
}
export async function testNotification() {
  emit({ busy: true, error: '' });
  try {
    const value = await notificationPreference(),
      reg = await registration();
    if (!value.enabled || permission() !== 'granted') throw new NotificationError('enableFirst');
    await new Promise<void>((resolve, reject) => {
      const ports = new MessageChannel(),
        timer = setTimeout(() => {
          ports.port1.close();
          reject(new NotificationError('testTimeout'));
        }, 5000);
      ports.port1.onmessage = (event) => {
        clearTimeout(timer);
        ports.port1.close();
        event.data?.ok ? resolve() : reject(new NotificationError('displayFailed'));
      };
      reg.active!.postMessage(
        { channel: NOTIFICATION_CHANNEL, type: 'test', revision: value.revision },
        [ports.port2],
      );
    });
  } catch (error) {
    fail(error);
  } finally {
    emit({ busy: false });
  }
}
export async function disableNotificationsForLogout() {
  stopped = true;
  generation++;
  closeSocket();
  const value = await notificationPreference();
  const disabled = await changeNotificationPreference({
    enabled: false,
    mode: 'never',
    push: false,
  });
  broadcast();
  await refresh();
  if (value.owner === owner && authorized() && navigator.onLine) {
    await api(
      '/notifications/device',
      'PUT',
      {
        instanceId: disabled.instanceId,
        revision: disabled.revision,
        mode: 'never',
        subscription: null,
      },
      undefined,
      3000,
    ).catch(() => {});
  }
}
