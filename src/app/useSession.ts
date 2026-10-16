import { useCallback, useEffect, useRef, useState } from 'react';
import { chatModels } from '../../shared/models/selection';
import type { ProviderSettings } from '../../shared/providers/types';
import { identityKey, type SessionInfo } from '../../shared/auth/types';
import { api, ApiError } from '../platform/api';
import { authorizeNetwork, beginSignOut, pendingLogout } from '../platform/auth';
import {
  clearLocal,
  lockStorageWrites,
  resumeStorageWrites,
  read,
  storageEpoch,
  write,
} from '../platform/storage';

export type SessionStatus =
  | 'loading'
  | 'authenticated'
  | 'offline'
  | 'reauth-required'
  | 'denied'
  | 'unavailable'
  | 'signed-out';
export function useSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [bootError, setBootError] = useState('');
  const version = useRef(0);
  const stopped = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loggedOut = useCallback(() => {
    ++version.current;
    authorizeNetwork(null);
    setSession(null);
    sessionRef.current = null;
    setStatus('reauth-required');
  }, []);
  const signOut = useCallback(() => {
    stopped.current = true;
    lockStorageWrites();
    beginSignOut(sessionRef.current?.logoutUrl ?? pendingLogout() ?? '/cdn-cgi/access/logout');
    setBootError('');
    loggedOut();
    setStatus('signed-out');
  }, [loggedOut]);
  const boot = useCallback(async () => {
    if (stopped.current) return;
    const request = ++version.current;
    const epoch = storageEpoch();
    setBootError('');
    try {
      const current = await api<SessionInfo>('/session');
      if (request !== version.current || epoch !== storageEpoch() || stopped.current) return;
      if (
        !current.authenticated ||
        !current.identity?.issuer ||
        !current.identity.sub ||
        !['/cdn-cgi/access/logout', '/__dev/access/logout'].includes(current.logoutUrl)
      )
        throw new Error('无效的会话响应。');
      const cached = read<SessionInfo | null>('access-session', null);
      if (cached?.identity && identityKey(cached.identity) !== identityKey(current.identity)) {
        await clearLocal();
        // Recreate app-owned caches and queues under the newly verified identity.
        location.reload();
        return;
      }
      resumeStorageWrites();
      authorizeNetwork(current.identity);
      sessionRef.current = current;
      setSession(current);
      setStatus('authenticated');
      write('access-session', current);
    } catch (error) {
      if (request !== version.current || epoch !== storageEpoch() || stopped.current) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        sessionRef.current = null;
        setSession(null);
        setStatus(error.status === 403 ? 'denied' : 'reauth-required');
        return;
      }
      const cached = read<SessionInfo | null>('access-session', null);
      if (cached?.identity && !navigator.onLine) {
        sessionRef.current = cached;
        setSession(cached);
        setStatus('offline');
      } else {
        setStatus('unavailable');
        setBootError(error instanceof Error ? error.message : '暂时无法连接你的空间。');
      }
    }
  }, []);
  const providerSaved = useCallback((config: ProviderSettings) => {
    const profile = config.providers.find((profile) => profile.id === config.activeProviderId);
    const model = profile?.models.find((model) => model.id === config.activeModel && model.enabled);
    setSession((current) => {
      if (!current?.authenticated || stopped.current) return current;
      const next = {
        ...current,
        provider: model ? profile!.provider : '',
        model: model?.id ?? '',
        modelName: model?.name || model?.id || '',
        activeProviderId: model ? profile!.id : null,
        models: chatModels(config),
        systemPrompt: config.systemPrompt,
        maxOutputTokens: config.maxOutputTokens,
      };
      write('access-session', next);
      return next;
    });
  }, []);
  useEffect(() => {
    // A fresh visit after Access login can resume; an offline local logout stays locked.
    if (pendingLogout()) {
      lockStorageWrites();
      stopped.current = true;
      setStatus('signed-out');
    } else {
      void boot();
    }
    const refresh = () => {
      void boot();
    };
    const offline = () => {
      authorizeNetwork(null);
      ++version.current;
      if (sessionRef.current) setStatus('offline');
    };
    const required = (event: Event) => {
      loggedOut();
      if ((event as CustomEvent<{ status: number }>).detail?.status === 403) setStatus('denied');
    };
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('everchat-access');
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === 'sign-out') {
          signOut();
          void clearLocal().catch((error: unknown) =>
            setBootError(error instanceof Error ? error.message : '本地记录未能完全清除。'),
          );
        }
      };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('offline', offline);
    window.addEventListener('everchat:auth-required', required);
    return () => {
      ++version.current;
      channel?.close();
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('offline', offline);
      window.removeEventListener('everchat:auth-required', required);
    };
  }, [boot, loggedOut, signOut]);
  return {
    session,
    sessionRef,
    status,
    bootError,
    boot,
    loggedOut,
    signOut,
    providerSaved,
    reportSignOutError: setBootError,
  };
}
