import { useEffect, useRef, useState } from 'react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { applyChange, type Snapshot, type SyncPacket } from '../shared/types';
import { api, ApiError } from './api';
import { cachedSnapshot, write } from './storage';

export type Connection = 'connected' | 'connecting' | 'offline';
export function useConversation(id: string | null, enabled: boolean, onUnauthorized: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ messages: [], seq: 0 });
  const [connection, setConnection] = useState<Connection>(navigator.onLine ? 'connecting' : 'offline');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    let alive = true;
    let socket: ReconnectingWebSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let generation = 0;
    let lastHeartbeat = Date.now();
    let current = id ? cachedSnapshot(id) : { messages: [], seq: 0 };
    setSnapshot(current);
    setSyncedAt(null);
    const update = (next: Snapshot) => {
      current = next;
      setSnapshot(next);
      if (id) write(`snapshot:${id}`, next);
      setSyncedAt(Date.now());
    };
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const startHeartbeat = () => {
      stopHeartbeat();
      attempt = 0;
      lastHeartbeat = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeartbeat > 60_000) { socket?.reconnect(); return; }
        if (socket?.readyState === ReconnectingWebSocket.OPEN) { socket.send('ping'); socket.send('session-check'); }
      }, 20_000);
    };
    const connect = async () => {
      if (!alive || !enabled) return;
      const token = ++generation;
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      if (socket) { socket.close(); socket = undefined; }
      if (!navigator.onLine) { setConnection('offline'); setLoading(false); return; }
      setConnection('connecting');
      if (!id) {
        try { await api('/session'); if (alive) setConnection('connected'); } catch { if (alive) setConnection('offline'); }
        return;
      }
      setLoading(current.messages.length === 0);
      try {
        const cloud = await api<Snapshot>(`/conversations/${id}`);
        if (!alive || token !== generation) return;
        update(cloud);
        const socketUrl = () => {
          const url = new URL(`/api/conversations/${id}/sync`, location.href);
          url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          url.searchParams.set('after', String(current.seq));
          return url.toString();
        };
        socket = new ReconnectingWebSocket(socketUrl, [], {
          maxReconnectionDelay: 15_000,
          minReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 2,
          connectionTimeout: 10_000,
        });
        socket.onopen = () => { if (alive && token === generation) { setConnection('connected'); setSyncedAt(Date.now()); startHeartbeat(); } };
        socket.onmessage = (event) => {
          if (!alive || token !== generation || event.data === 'pong') return;
          lastHeartbeat = Date.now();
          try {
            const packet = JSON.parse(event.data) as SyncPacket;
            if (packet.type === 'snapshot') update(packet.snapshot);
            if (packet.type === 'change') update(applyChange(current, packet));
            if (packet.type === 'ready') {
              if (packet.seq !== current.seq) { socket?.reconnect(); return; }
              setConnection('connected'); setSyncedAt(Date.now());
            }
          } catch { socket?.reconnect(); }
        };
        socket.onclose = (event) => {
          if (!alive || token !== generation) return;
          stopHeartbeat();
          if (event.code === 4001) { socket?.close(); unauthorized.current(); return; }
          setConnection(navigator.onLine ? 'connecting' : 'offline');
        };
      } catch (error) {
        if (!alive || token !== generation) return;
        if (error instanceof ApiError && error.status === 401) { unauthorized.current(); return; }
        setConnection(navigator.onLine ? 'connecting' : 'offline');
        if (navigator.onLine) retry = setTimeout(() => { void connect(); }, Math.min(15_000, 1_000 * 2 ** attempt++));
      } finally { if (alive && token === generation) setLoading(false); }
    };
    const online = () => { void connect(); };
    const offline = () => {
      generation++;
      if (retry) clearTimeout(retry);
      stopHeartbeat();
      if (socket) { socket.close(); socket = undefined; }
      setConnection('offline'); setLoading(false);
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && socket?.readyState !== ReconnectingWebSocket.OPEN) online();
    };
    void connect();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; generation++; if (retry) clearTimeout(retry); stopHeartbeat(); socket?.close();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [id, enabled]);
  return { snapshot, connection, syncedAt, loading };
}
