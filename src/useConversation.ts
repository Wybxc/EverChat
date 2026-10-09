import { useEffect, useRef, useState } from 'react';
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
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let generation = 0;
    let current = id ? cachedSnapshot(id) : { messages: [], seq: 0 };
    setSnapshot(current);
    setSyncedAt(null);
    const update = (next: Snapshot) => {
      current = next;
      setSnapshot(next);
      if (id) write(`snapshot:${id}`, next);
      setSyncedAt(Date.now());
    };
    const connect = async () => {
      if (!alive || !enabled) return;
      const token = ++generation;
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
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
        const url = new URL(`/api/conversations/${id}/sync`, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('after', String(current.seq));
        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          if (!alive || token !== generation || event.data === 'pong') return;
          try {
            const packet = JSON.parse(event.data) as SyncPacket;
            if (packet.type === 'snapshot') update(packet.snapshot);
            if (packet.type === 'change') update(applyChange(current, packet));
            if (packet.type === 'ready') {
              if (packet.seq !== current.seq) { socket?.close(); return; }
              setConnection('connected'); setSyncedAt(Date.now()); attempt = 0;
            }
          } catch { socket?.close(); }
        };
        socket.onclose = (event) => {
          if (!alive || token !== generation) return;
          if (heartbeat) clearInterval(heartbeat);
          if (event.code === 4001) { unauthorized.current(); return; }
          schedule();
        };
        socket.onerror = () => socket?.close();
        let lastHeartbeat = Date.now();
        const originalMessage = socket.onmessage;
        socket.onmessage = (event) => { lastHeartbeat = Date.now(); originalMessage?.call(socket!, event); };
        heartbeat = setInterval(() => {
          if (Date.now() - lastHeartbeat > 60_000) { socket?.close(); return; }
          if (socket?.readyState === WebSocket.OPEN) { socket.send('ping'); socket.send('session-check'); }
        }, 20_000);
      } catch (error) {
        if (!alive || token !== generation) return;
        if (error instanceof ApiError && error.status === 401) { unauthorized.current(); return; }
        schedule();
      } finally { if (alive && token === generation) setLoading(false); }
    };
    const schedule = () => {
      setConnection(navigator.onLine ? 'connecting' : 'offline');
      if (reconnect) clearTimeout(reconnect);
      if (navigator.onLine) reconnect = setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++));
    };
    const online = () => { void connect(); };
    const offline = () => {
      generation++;
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
      setConnection('offline'); setLoading(false);
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && socket?.readyState !== WebSocket.OPEN) online();
    };
    void connect();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; socket?.close();
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [id, enabled]);
  return { snapshot, connection, syncedAt, loading };
}
