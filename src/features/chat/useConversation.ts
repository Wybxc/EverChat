import { useEffect, useRef, useState } from 'react';
import { syncRetryDelay } from '../../platform/sync/backoff';
import { isActive } from '../../../shared/conversation/message-state';
import {
  type Snapshot,
  type SnapshotPage,
  type SyncPacket,
} from '../../../shared/streaming/protocol';
import { StreamSync } from '../../../shared/streaming/sync';
import { api, ApiError } from '../../platform/api';
import { errorMessage, UiError, uiMessage, type UiMessage } from '../../platform/i18n/messages';
import { storageEpoch } from '../../platform/storage';
import { cachedSnapshot, writeChatCache as write } from './cache';
import { SnapshotWriter } from './snapshot-writer';

type Connection = 'connected' | 'connecting' | 'offline' | 'unavailable';
export function useConversation(
  id: string | null,
  enabled: boolean,
  onUnauthorized: () => void,
  awaitingAcceptance = false,
  onDeleted?: (id: string, deletedAt: number) => void,
  confirmedDeletion: number | null = null,
) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ messages: [], seq: 0 });
  const [durableSnapshot, setDurableSnapshot] = useState<Snapshot>({ messages: [], seq: 0 });
  const [hasUnconfirmed, setHasUnconfirmed] = useState(false);
  const [connection, setConnection] = useState<Connection>(
    navigator.onLine ? 'connecting' : 'offline',
  );
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [snapshotFor, setSnapshotFor] = useState<string | null>(null);
  const [authoritativeFor, setAuthoritativeFor] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<UiMessage>('');
  const [connectionError, setConnectionError] = useState<UiMessage>('');
  const [retryVersion, setRetryVersion] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const deletionNotice = useRef(onDeleted);
  deletionNotice.current = onDeleted;

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | undefined;
    let request: AbortController | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lease: ReturnType<typeof setTimeout> | undefined;
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let needsSnapshot = false;
    let attempt = 0;
    let generation = 0;
    let lastHeartbeat = Date.now();
    const sync = new StreamSync(id && enabled ? cachedSnapshot(id) : { messages: [], seq: 0 });
    setAuthoritativeFor(null);
    const epoch = storageEpoch();
    const writer = new SnapshotWriter((next) => {
      if (id && enabled && epoch === storageEpoch()) write(`snapshot:${id}`, next);
    });
    const render = () => {
      setSnapshotFor(id);
      setSnapshot(sync.view);
      setDurableSnapshot(sync.durable);
      setHasUnconfirmed(sync.hasPreview);
    };
    render();
    setSyncedAt(null);
    setSyncError('');
    setConnectionError('');
    const receive = (packet: SyncPacket) => {
      if (sync.receive(packet)) {
        writer.schedule(
          sync.durable,
          packet.type === 'snapshot' || !sync.durable.messages.some(isActive),
        );
        setSyncedAt(Date.now());
      }
      render();
    };
    const resetPreview = () => {
      sync.resetPreview();
      render();
    };
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      clearTimeout(lease);
      clearTimeout(handshake);
    };
    const rememberDeletion = (deletedAt: number) => {
      generation++;
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      socket?.close();
      receive({ type: 'deleted', deletedAt });
      setSyncError(uiMessage('chat', 'chatDeleted'));
      setConnection('unavailable');
      setLoading(false);
      if (id) deletionNotice.current?.(id, deletedAt);
    };
    const startHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      lastHeartbeat = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeartbeat > 60_000) {
          socket?.close();
          return;
        }
        if (socket?.readyState === WebSocket.OPEN) {
          attempt = 0;
          socket.send('ping');
        }
      }, 20_000);
    };
    const connect = async () => {
      if (!alive || !enabled || document.visibilityState === 'hidden') return;
      const token = ++generation;
      request?.abort();
      request = new AbortController();
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = undefined;
      }
      resetPreview();
      setSyncError('');
      if (sync.durable.deletedAt) {
        rememberDeletion(sync.durable.deletedAt);
        return;
      }
      if (!navigator.onLine) {
        setConnection('offline');
        setLoading(false);
        return;
      }
      setConnection('connecting');
      if (!id) {
        setConnection('connected');
        return;
      }
      setLoading(sync.durable.messages.length === 0);
      try {
        if (needsSnapshot || !sync.durable.epoch) {
          const first = await api<SnapshotPage>(
            `/conversations/${id}?after=0`,
            'GET',
            undefined,
            request.signal,
          );
          let page = first;
          const cloud: Snapshot = { ...first.snapshot, messages: [...first.snapshot.messages] };
          while (!page.done) {
            const next = await api<SnapshotPage>(
              `/conversations/${id}?after=${page.after}`,
              'GET',
              undefined,
              request.signal,
            );
            if (next.after <= page.after || next.snapshot.epoch !== cloud.epoch)
              throw new UiError(uiMessage('chat', 'paginationChanged'));
            cloud.messages.push(...next.snapshot.messages);
            page = next;
          }
          if (!alive || token !== generation) return;
          setAuthoritativeFor(id);
          setConnectionError('');
          receive({ type: 'snapshot', snapshot: cloud });
          needsSnapshot = false;
        }
        const socketUrl = () => {
          const url = new URL(`/api/conversations/${id}/sync`, location.href);
          url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          url.searchParams.set('after', String(sync.durable.seq));
          if (sync.durable.epoch) url.searchParams.set('epoch', sync.durable.epoch);
          return url.toString();
        };
        socket = new WebSocket(socketUrl());
        handshake = setTimeout(() => socket?.close(), 15_000);
        socket.onopen = () => {
          if (alive && token === generation) {
            resetPreview();
            startHeartbeat();
          }
        };
        socket.onmessage = (event) => {
          if (!alive || token !== generation) return;
          lastHeartbeat = Date.now();
          if (event.data === 'pong') return;
          try {
            const packet = JSON.parse(event.data) as SyncPacket;
            if (packet.type === 'deleted') {
              rememberDeletion(packet.deletedAt);
              return;
            }
            receive(packet);
            if (packet.type === 'preview' && socket?.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: 'preview-ack',
                  runId: packet.batch.runId,
                  messageId: packet.batch.messageId,
                  offset: packet.batch.endOffset,
                }),
              );
            }
            if (packet.type === 'ready') {
              if (!Number.isSafeInteger(packet.revalidateAt) || packet.revalidateAt <= Date.now())
                throw new Error('Invalid access lease');
              clearTimeout(handshake);
              lease = setTimeout(
                () => void connect(),
                Math.max(1, packet.revalidateAt - Date.now()),
              );
              setAuthoritativeFor(id);
              setConnectionError('');
              setConnection('connected');
              setSyncedAt(Date.now());
            }
          } catch {
            needsSnapshot = true;
            stopHeartbeat();
            if (socket) {
              socket.onclose = null;
              socket.close();
              socket = undefined;
            }
            resetPreview();
            setConnection('connecting');
            retry = setTimeout(() => void connect(), syncRetryDelay(attempt++));
          }
        };
        socket.onclose = (event) => {
          if (!alive || token !== generation) return;
          stopHeartbeat();
          resetPreview();
          if (event.code === 4001 || event.code === 4004) {
            socket?.close();
            void connect();
            return;
          }
          if (event.code === 4003) {
            rememberDeletion(Date.now());
            return;
          }
          setConnection(navigator.onLine ? 'connecting' : 'offline');
          if (navigator.onLine && document.visibilityState !== 'hidden') {
            socket?.close();
            // A failed upgrade hides its HTTP status. Check permission without
            // reloading message history, then use the same HTTP failure path.
            void api(`/conversations/${id}/access`).then(
              () => {
                if (alive && token === generation)
                  retry = setTimeout(() => void connect(), syncRetryDelay(attempt++));
              },
              (error: unknown) => {
                if (alive && token === generation) failed(error);
              },
            );
          }
        };
      } catch (error) {
        failed(error);
      } finally {
        if (alive && token === generation) setLoading(false);
      }
      function failed(error: unknown) {
        if (!alive || token !== generation) return;
        if (error instanceof ApiError && error.status === 401) {
          unauthorized.current();
          return;
        }
        if (error instanceof ApiError && error.status === 410) {
          rememberDeletion(Date.now());
          return;
        }
        // An offline outbox can reconnect before its conversation has been created in the cloud.
        const pendingCreation =
          error instanceof ApiError && error.status === 404 && awaitingAcceptance;
        if (
          error instanceof ApiError &&
          !pendingCreation &&
          (error.status === 507 ||
            (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)))
        ) {
          setSyncError(errorMessage(error));
          setConnection('unavailable');
          return;
        }
        setConnectionError(errorMessage(error, uiMessage('chat', 'syncFailed')));
        setConnection(navigator.onLine ? 'connecting' : 'offline');
        if (navigator.onLine && document.visibilityState !== 'hidden')
          retry = setTimeout(() => {
            void connect();
          }, syncRetryDelay(attempt++));
      }
    };
    const online = () => {
      void connect();
    };
    const offline = () => {
      generation++;
      request?.abort();
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = undefined;
      }
      resetPreview();
      setConnection('offline');
      setLoading(false);
    };
    const visible = () => {
      if (document.visibilityState === 'hidden') {
        writer.flush();
        offline();
      } else online();
    };
    void connect();
    window.addEventListener('everchat:network-ready', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    const prepareReload = () => writer.flush();
    window.addEventListener('everchat:prepare-reload', prepareReload);
    return () => {
      writer.flush();
      alive = false;
      generation++;
      request?.abort();
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      socket?.close();
      window.removeEventListener('everchat:network-ready', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('everchat:prepare-reload', prepareReload);
    };
  }, [id, enabled, retryVersion, awaitingAcceptance, confirmedDeletion]);
  return {
    snapshot,
    snapshotFor,
    authoritative: authoritativeFor === id,
    durableSnapshot,
    hasUnconfirmed,
    connection,
    syncedAt,
    loading:
      loading ||
      Boolean(
        id &&
        enabled &&
        !syncError &&
        connection === 'connecting' &&
        !snapshot.messages.length &&
        authoritativeFor !== id,
      ),
    syncError,
    connectionError,
    reconnect: () => setRetryVersion((value) => value + 1),
  };
}
