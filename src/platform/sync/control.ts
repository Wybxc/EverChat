import * as v from 'valibot';
import {
  controlReadySchema,
  libraryChangedSchema,
  type LibraryWatermark,
} from '../../../shared/library/protocol';
import { completionSchema, type NotificationPacket } from '../../../shared/notifications/protocol';
import { identityKey } from '../../../shared/auth/types';
import { api, ApiError } from '../api';
import { networkIdentity, notifyAuthFailure } from '../auth';
import { syncRetryDelay } from './backoff';

type ControlState = {
  ready: boolean;
  watermark?: LibraryWatermark;
  connection: number;
  error: boolean;
};
let state: ControlState = { ready: false, connection: 0, error: false };
const listeners = new Set<() => void>();
const packets = new Set<(packet: NotificationPacket) => void>();
export const controlSnapshot = () => state;
export const subscribeControl = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const onControlPacket = (listener: (packet: NotificationPacket) => void) => {
  packets.add(listener);
  return () => {
    packets.delete(listener);
  };
};
const emit = (patch: Partial<ControlState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
let socket: WebSocket | undefined;
let cleanup: (() => void) | undefined;
let key: string | undefined;
export const sendControl = (value: string) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(value);
};
export function stopControl() {
  cleanup?.();
  cleanup = undefined;
  key = undefined;
}
export function startControl(owner: string, instanceId: string) {
  const nextKey = JSON.stringify([owner, instanceId]);
  if (nextKey === key) return;
  stopControl();
  key = nextKey;
  let stopped = false,
    attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  const active = () =>
    !stopped &&
    navigator.onLine &&
    document.visibilityState !== 'hidden' &&
    networkIdentity() &&
    identityKey(networkIdentity()!) === owner;
  const close = () => {
    clearTimeout(timer);
    clearTimeout(lease);
    clearInterval(heartbeat);
    const old = socket;
    socket = undefined;
    if (old) {
      old.onclose = null;
      old.close();
    }
    emit({ ready: false });
  };
  const reconnect = () => {
    if (!active()) return;
    timer = setTimeout(connect, syncRetryDelay(attempt++));
  };
  const connect = () => {
    close();
    if (!active()) return;
    const url = new URL(
      `/api/notifications/sync?instance=${encodeURIComponent(instanceId)}`,
      location.origin,
    );
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = (socket = new WebSocket(url));
    let lastMessage = Date.now();
    // Also bounds an upgrade that opens but never supplies its baseline.
    timer = setTimeout(() => ws.close(), 15_000);
    ws.onmessage = (event) => {
      if (socket !== ws || !active()) return;
      lastMessage = Date.now();
      if (event.data === 'pong') return;
      try {
        const packet = JSON.parse(event.data) as NotificationPacket;
        if (packet.type === 'ready') {
          const value = v.parse(controlReadySchema, packet);
          if (value.revalidateAt <= Date.now()) throw new Error('Expired control lease');
          clearTimeout(timer);
          clearTimeout(lease);
          clearInterval(heartbeat);
          emit({
            ready: true,
            watermark: value.library,
            connection: state.connection + 1,
            error: false,
          });
          lease = setTimeout(connect, Math.max(1, value.revalidateAt - Date.now()));
          heartbeat = setInterval(() => {
            if (Date.now() - lastMessage > 90_000) ws.close();
            else if (ws.readyState === WebSocket.OPEN) {
              attempt = 0;
              ws.send('ping');
            }
          }, 30_000);
        } else if (packet.type === 'library-changed') {
          const { library } = v.parse(libraryChangedSchema, packet);
          if (!state.ready) throw new Error('Missing control baseline');
          if (
            state.watermark?.epoch !== library.epoch ||
            state.watermark.revision < library.revision
          )
            emit({ watermark: library });
        } else if (packet.type === 'check' && typeof packet.id === 'string') {
          for (const listener of packets) listener(packet);
        } else if (
          packet.type === 'local' &&
          v.is(completionSchema, packet.completion) &&
          Number.isSafeInteger(packet.revision)
        ) {
          for (const listener of packets) listener(packet);
        } else throw new Error('Invalid control packet');
      } catch {
        emit({ ready: false, error: true });
        ws.close(4002, 'Reconnect to sync');
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws || stopped) return;
      socket = undefined;
      clearTimeout(timer);
      clearTimeout(lease);
      clearInterval(heartbeat);
      emit({ ready: false, error: event.code !== 4404 });
      if (event.code === 4401) {
        notifyAuthFailure(401);
        return;
      }
      if (!active()) return;
      if (event.code === 4404) {
        connect();
        return;
      }
      // Upgrade failures conceal HTTP status. Use a small authenticated endpoint
      // to detect actual expiry; it does not read the Library or write settings.
      void api('/notifications/config')
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) notifyAuthFailure(401);
        })
        .finally(() => {
          if (!stopped && !socket) reconnect();
        });
    };
  };
  const resume = () => {
    if (!socket && active()) connect();
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') close();
    else resume();
  };
  window.addEventListener('online', resume);
  window.addEventListener('offline', close);
  window.addEventListener('everchat:network-ready', resume);
  document.addEventListener('visibilitychange', visibility);
  cleanup = () => {
    stopped = true;
    close();
    window.removeEventListener('online', resume);
    window.removeEventListener('offline', close);
    window.removeEventListener('everchat:network-ready', resume);
    document.removeEventListener('visibilitychange', visibility);
  };
  connect();
}
