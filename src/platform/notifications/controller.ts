import { registerNotificationCleanup } from '../storage';
import { clearNotificationLocal } from './cleanup';
import * as v from 'valibot';
import {
  completionSchema,
  NOTIFICATION_CHANNEL,
  type NotificationDevice,
  type NotificationMode,
  type NotificationPacket,
} from '../../../shared/notifications/protocol';
import { identityKey } from '../../../shared/auth/types';
import { api } from '../api';
import { serializePushSubscription } from './subscription';
import { networkIdentity, notifyAuthFailure } from '../auth';
import {
  acknowledgeNotificationPreference,
  changeNotificationPreference,
  notificationPreference,
  type NotificationPreference,
} from './store';

registerNotificationCleanup(clearNotificationLocal);

export interface NotificationState {
  mode: NotificationMode;
  permission: NotificationPermission | 'unsupported';
  enabled: boolean;
  ready: 'none' | 'local' | 'push';
  pending: boolean;
  busy: boolean;
  error: string;
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
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let stopped = true,
  generation = 0,
  retry = 1000;
let syncing: Promise<void> | null = null;
let navigating: ((conversationId: string, messageId: string) => void) | null = null;
const registration = async () => {
  if (!('serviceWorker' in navigator)) throw new Error('当前环境不支持系统通知。');
  const value = await navigator.serviceWorker.getRegistration('/');
  if (!value?.active) throw new Error('应用通知尚未就绪，请等待应用准备完成后重试。');
  return value;
};
const authorized = () => {
  const identity = networkIdentity();
  return owner && identity && owner === identityKey(identity);
};
const broadcast = () => channel?.postMessage('changed');
const fail = (error: unknown) =>
  emit({ error: error instanceof Error ? error.message : '通知设置失败，请重试。' });
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
const closeSocket = () => {
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  const old = socket;
  socket = null;
  if (old) {
    old.onclose = null;
    old.close();
  }
};
function connect(value: NotificationPreference) {
  if (stopped || !authorized() || !navigator.onLine) {
    closeSocket();
    return;
  }
  if (socket) return;
  const current = generation;
  const url = new URL(
    `/api/notifications/sync?instance=${encodeURIComponent(value.instanceId)}`,
    location.origin,
  );
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = (socket = new WebSocket(url));
  ws.onopen = () => {
    retry = 1000;
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 30_000);
  };
  ws.onmessage = (event) => {
    if (stopped || current !== generation || socket !== ws || !authorized()) return;
    if (event.data === 'pong') return;
    try {
      const packet = JSON.parse(event.data) as NotificationPacket;
      if (packet.type === 'check' && typeof packet.id === 'string')
        ws.send(
          JSON.stringify({
            type: 'check',
            id: packet.id,
            foreground: document.visibilityState === 'visible' && document.hasFocus(),
          }),
        );
      if (packet.type === 'local' && v.is(completionSchema, packet.completion))
        void registration()
          .then((reg) => reg.active?.postMessage({ channel: NOTIFICATION_CHANNEL, ...packet }))
          .catch(fail);
    } catch {
      /* Ignore malformed control packets. */
    }
  };
  ws.onclose = (event) => {
    clearInterval(heartbeat);
    if (socket === ws) socket = null;
    if (event.code === 4401) {
      notifyAuthFailure(401);
      return;
    }
    if (stopped || current !== generation) return;
    reconnect = setTimeout(() => void refresh().then(connect).catch(fail), retry);
    retry = Math.min(15_000, retry * 2);
  };
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
  let reason = '';
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
        subscription ??= await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
      } catch {
        reason = '后台推送未能启用；当前仅支持页面在线时通知。可重试启用。';
      }
    } else reason = '当前仅支持页面在线时通知。';
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
  if (value.push !== Boolean(subscription)) {
    value = await changeNotificationPreference({ push: Boolean(subscription) });
    await refresh();
  }
  const input: NotificationDevice = {
    instanceId: value.instanceId,
    revision: value.revision,
    mode: value.enabled && permission() === 'granted' ? value.mode : 'never',
    subscription: subscription ? serializePushSubscription(subscription) : null,
  };
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
  stopped = false;
  owner = identity;
  navigating = navigate;
  generation++;
  channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NOTIFICATION_CHANNEL);
  if (channel) channel.onmessage = () => void refresh().then(connect).catch(fail);
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
    fail(new Error('请先恢复连接并登录。'));
    return;
  }
  if (permission() === 'unsupported') {
    fail(new Error('当前环境不支持；iPhone／iPad 请先添加到主屏幕，再从应用中启用。'));
    return;
  }
  // Keep permission request in the original click gesture, before any asynchronous work.
  const expectedOwner = owner,
    expectedGeneration = generation;
  emit({ busy: true, error: '' });
  try {
    const result = Notification.requestPermission();
    if ((await result) !== 'granted')
      throw new Error('通知未获允许，请在浏览器或系统设置中允许通知。');
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
    if (!value.enabled || permission() !== 'granted') throw new Error('请先启用系统通知。');
    await new Promise<void>((resolve, reject) => {
      const ports = new MessageChannel(),
        timer = setTimeout(() => {
          ports.port1.close();
          reject(new Error('通知测试超时，请重试。'));
        }, 5000);
      ports.port1.onmessage = (event) => {
        clearTimeout(timer);
        ports.port1.close();
        event.data?.ok ? resolve() : reject(new Error('系统通知显示失败。'));
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
