import { useEffect, useRef, useState } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { StreamSync } from '../../../shared/streaming/sync';
import { isActive } from '../../../shared/conversation/message-state';
import { type Snapshot, type SyncPacket } from '../../../shared/streaming/protocol';
import { api, ApiError } from '../../platform/api';
import { notifyAuthFailure } from '../../platform/auth';
import { SnapshotWriter } from './snapshot-writer';
import { storageEpoch } from '../../platform/storage';
import { cachedSnapshot, writeChatCache as write } from './cache';

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
  const [syncError, setSyncError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const deletionNotice = useRef(onDeleted);
  deletionNotice.current = onDeleted;

  useEffect(() => {
    let alive = true;
    let socket: ReconnectingWebSocket | undefined;
    let request: AbortController | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
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
    };
    const rememberDeletion = (deletedAt: number) => {
      generation++;
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      socket?.close();
      receive({ type: 'deleted', deletedAt });
      setSyncError('这个对话已删除。');
      setConnection('unavailable');
      setLoading(false);
      if (id) deletionNotice.current?.(id, deletedAt);
    };
    const startHeartbeat = () => {
      stopHeartbeat();
      attempt = 0;
      lastHeartbeat = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeartbeat > 60_000) {
          socket?.reconnect();
          return;
        }
        if (socket?.readyState === ReconnectingWebSocket.OPEN) {
          socket.send('ping');
          socket.send('session-check');
        }
      }, 20_000);
    };
    const connect = async () => {
      if (!alive || !enabled) return;
      const token = ++generation;
      request?.abort();
      request = new AbortController();
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      if (socket) {
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
        const cloud = await api<Snapshot>(`/conversations/${id}`, 'GET', undefined, request.signal);
        if (!alive || token !== generation) return;
        setAuthoritativeFor(id);
        setConnectionError('');
        receive({ type: 'snapshot', snapshot: cloud });
        const socketUrl = () => {
          const url = new URL(`/api/conversations/${id}/sync`, location.href);
          url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          url.searchParams.set('after', String(sync.durable.seq));
          return url.toString();
        };
        socket = new ReconnectingWebSocket(socketUrl, [], {
          maxReconnectionDelay: 15_000,
          minReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 2,
          connectionTimeout: 10_000,
        });
        socket.onopen = () => {
          if (alive && token === generation) {
            resetPreview();
            startHeartbeat();
          }
        };
        socket.onmessage = (event) => {
          if (!alive || token !== generation || event.data === 'pong') return;
          lastHeartbeat = Date.now();
          try {
            const packet = JSON.parse(event.data) as SyncPacket;
            if (packet.type === 'deleted') {
              rememberDeletion(packet.deletedAt);
              return;
            }
            receive(packet);
            if (packet.type === 'preview' && socket?.readyState === ReconnectingWebSocket.OPEN) {
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
              setConnection('connected');
              setSyncedAt(Date.now());
            }
          } catch {
            resetPreview();
            setConnection('connecting');
            socket?.reconnect();
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
          if (navigator.onLine) {
            socket?.close();
            retry = setTimeout(() => void connect(), Math.min(15_000, 1000 * 2 ** attempt++));
          }
        };
      } catch (error) {
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
          setSyncError(error.message);
          setConnection('unavailable');
          return;
        }
        setConnectionError(error instanceof Error ? error.message : '暂时无法更新对话。');
        setConnection(navigator.onLine ? 'connecting' : 'offline');
        if (navigator.onLine)
          retry = setTimeout(
            () => {
              void connect();
            },
            Math.min(15_000, 1_000 * 2 ** attempt++),
          );
      } finally {
        if (alive && token === generation) setLoading(false);
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
        socket.close();
        socket = undefined;
      }
      resetPreview();
      setConnection('offline');
      setLoading(false);
    };
    const visible = () => {
      if (document.visibilityState === 'hidden') writer.flush();
      if (
        document.visibilityState === 'visible' &&
        socket?.readyState !== ReconnectingWebSocket.OPEN
      )
        online();
    };
    void connect();
    window.addEventListener('everchat:network-ready', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
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
