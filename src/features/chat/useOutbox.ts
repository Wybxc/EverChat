import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SessionInfo } from '../../../shared/auth/types';
import { identityKey } from '../../../shared/auth/types';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import type { Submission } from '../../../shared/conversation/types';
import { api, ApiError } from '../../platform/api';
import { networkIdentity } from '../../platform/auth';
import { errorMessage, uiMessage, type UiMessage } from '../../platform/i18n/messages';
import { read, storageEpoch } from '../../platform/storage';
import { deletedAt, writePending, type Pending } from './cache';

type OutboxOptions = {
  authenticated: boolean;
  sessionRef: RefObject<SessionInfo | null>;
  selectedRef: RefObject<string | null>;
  getView: () => { head: string | null; version: number };
  onAccepted: (result: Submission, item: Pending) => void;
  onActivity: (id: string, activity: ConversationActivity) => void;
  onUnauthorized: () => void;
  onDeleted: (id: string, time: number) => void;
  refreshLibrary: () => void;
  setError: (error: UiMessage) => void;
};

export function useOutbox(options: OutboxOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [pending, setPending] = useState<Pending[]>(() =>
    read<Pending[]>('pending', []).filter((item) => !deletedAt(item.conversation.id)),
  );
  const pendingRef = useRef(pending);
  const deliveryLocks = useRef(new Set<string>());
  const followRequests = useRef(new Map<string, { id: string; version: number }>());
  const commitPending = (items: Pending[]) => {
    items = items.filter((item) => !deletedAt(item.conversation.id));
    if (!writePending(items)) {
      latest.current.setError(uiMessage('chat', 'outboxFull'));
      return false;
    }
    pendingRef.current = items;
    setPending(items);
    return true;
  };
  const { sessionRef, selectedRef } = options;
  const deliver = async (item: Pending) => {
    if (deletedAt(item.conversation.id)) return;
    const identity = networkIdentity();
    if (!identity || item.owner !== identityKey(identity)) return;
    const epoch = storageEpoch();
    const key = item.input.requestId;
    if (deliveryLocks.current.has(key) || !navigator.onLine || !sessionRef.current?.authenticated)
      return;
    if (
      !followRequests.current.has(key) &&
      selectedRef.current === item.conversation.id &&
      latest.current.getView().head === (item.viewHeadId ?? null)
    ) {
      followRequests.current.set(key, {
        id: item.conversation.id,
        version: latest.current.getView().version,
      });
    }
    deliveryLocks.current.add(key);
    try {
      await api('/conversations', 'POST', {
        id: item.conversation.id,
        title: item.conversation.title,
        titleSource: 'fallback',
      });
      const accepted = await api<Submission>(
        `/conversations/${item.conversation.id}/messages`,
        'POST',
        item.input,
      );
      if (epoch !== storageEpoch() || !networkIdentity()) return;
      if (accepted.activity) latest.current.onActivity(item.conversation.id, accepted.activity);
      const follow = followRequests.current.get(key);
      if (
        !item.input.summaryThrough &&
        follow &&
        selectedRef.current === follow.id &&
        latest.current.getView().version === follow.version
      ) {
        latest.current.onAccepted(accepted, item);
      }
      followRequests.current.delete(key);
      commitPending(pendingRef.current.filter((next) => next.input.requestId !== key));
      latest.current.refreshLibrary();
    } catch (error) {
      if (epoch !== storageEpoch()) return;
      if (error instanceof ApiError && error.status === 401) latest.current.onUnauthorized();
      else if (error instanceof ApiError && error.status === 410)
        latest.current.onDeleted(item.conversation.id, Date.now());
      else if (
        error instanceof ApiError &&
        error.code !== 'AUTH_UNAVAILABLE' &&
        error.code !== 'ACCESS_DENIED'
      )
        commitPending(
          pendingRef.current.map((next) =>
            next.input.requestId === key ? { ...next, error: errorMessage(error) } : next,
          ),
        );
      // A network error has an unknown outcome: keep the same request ID for retry.
    } finally {
      deliveryLocks.current.delete(key);
    }
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  useEffect(() => {
    const flush = () => {
      for (const item of pendingRef.current) if (!item.error) void deliverRef.current(item);
    };
    flush();
    const timer = setInterval(flush, 5000);
    window.addEventListener('everchat:network-ready', flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener('everchat:network-ready', flush);
    };
  }, [options.authenticated, pending.length]);

  return { pending, pendingRef, setPending, followRequests, commitPending, deliver };
}
