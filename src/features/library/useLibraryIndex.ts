import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationInfo, LibrarySnapshot } from '../../../shared/conversation/types';
import {
  mergeActivity,
  type ActivityIndex,
  type ConversationActivity,
} from '../../../shared/conversation/activity';
import { api, ApiError } from '../../platform/api';
import { read, storageEpoch, write } from '../../platform/storage';
import type { Pending } from '../chat/cache';
import { deletedAt } from '../chat/cache';

export function useLibraryIndex({
  enabled,
  pending,
  onDeleted,
  onUnauthorized,
}: {
  enabled: boolean;
  pending: Pending[];
  onDeleted: (id: string, time: number) => void;
  onUnauthorized: () => void;
}) {
  const queryClient = useQueryClient();
  const [localConversations, setLocalConversations] = useState<ConversationInfo[]>(() =>
    read('library', []),
  );
  const [activities, setActivities] = useState<ActivityIndex>(() => read('library-activity', {}));
  const activityRef = useRef(activities);
  const seenAt = useRef<Record<string, number>>({});
  const [clock, setClock] = useState(Date.now);
  const [online, setOnline] = useState(navigator.onLine);
  const observeActivity = useCallback((id: string, activity: ConversationActivity) => {
    if (deletedAt(id)) return;
    const previous = activityRef.current;
    const next = mergeActivity(previous, id, activity);
    if ((previous[id]?.version ?? 0) <= activity.version) seenAt.current[id] = Date.now();
    if (next !== previous) {
      activityRef.current = next;
      setActivities(next);
      write('library-activity', next);
    }
  }, []);
  const hasActivity = Object.values(activities).some((item) => item.status !== 'idle');
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setClock(Date.now());
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const timer = hasActivity ? setInterval(() => setClock(Date.now()), 5000) : undefined;
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [hasActivity]);
  const libraryQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async ({ signal }) => {
      const epoch = storageEpoch();
      let page: LibrarySnapshot;
      do {
        page = await api<LibrarySnapshot>(
          `/conversations?after=${read('library-deletion-cursor', 0)}`,
          'GET',
          undefined,
          signal,
        );
        if (epoch !== storageEpoch()) throw new DOMException('Session changed', 'AbortError');
        for (const deletion of page.deletions) onDeleted(deletion.id, deletion.deletedAt);
        for (const [id, activity] of Object.entries(page.activity)) observeActivity(id, activity);
        write('library-deletion-cursor', page.deletionCursor);
      } while (page.hasMoreDeletions);
      return page.conversations;
    },
    enabled: enabled,
    initialData: () => read<ConversationInfo[] | undefined>('library', undefined),
    refetchInterval: 10_000,
  });
  const conversations = useMemo(() => {
    const cloud = libraryQuery.data ?? [];
    const cloudIds = new Set(cloud.map((item) => item.id));
    const queued = pending
      .map((item) => item.conversation)
      .filter((item) => !cloudIds.has(item.id));
    const local = localConversations.filter(
      (item) => !cloudIds.has(item.id) && !queued.some((next) => next.id === item.id),
    );
    return [...queued, ...local, ...cloud]
      .filter((item) => !deletedAt(item.id))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      );
  }, [libraryQuery.data, localConversations, pending]);

  useEffect(() => {
    if (libraryQuery.error instanceof ApiError && libraryQuery.error.status === 401)
      onUnauthorized();
    if (enabled && libraryQuery.data) {
      setLocalConversations(libraryQuery.data);
      write('library', libraryQuery.data);
    }
  }, [enabled, libraryQuery.data, libraryQuery.error, onUnauthorized]);
  const refreshLibrary = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['body-search'] });
  }, [queryClient]);

  const forgetConversation = useCallback(
    (id: string) => {
      const next = { ...activityRef.current };
      delete next[id];
      delete seenAt.current[id];
      activityRef.current = next;
      setActivities(next);
      write('library-activity', next);
      setLocalConversations((items) => items.filter((item) => item.id !== id));
      queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) =>
        items?.filter((item) => item.id !== id),
      );
      write(
        'library',
        read<ConversationInfo[]>('library', []).filter((item) => item.id !== id),
      );
    },
    [queryClient],
  );
  const rememberConversation = (conversation: ConversationInfo) => {
    const items = [conversation, ...localConversations];
    setLocalConversations(items);
    write('library', items);
  };
  return {
    conversations,
    activities,
    observeActivity,
    activityFresh: (id: string) =>
      online && !libraryQuery.isError && clock - (seenAt.current[id] ?? 0) < 25_000,
    savedIds: new Set((libraryQuery.data ?? []).map((item) => item.id)),
    libraryLoading: !conversations.length && libraryQuery.isLoading,
    libraryError: libraryQuery.isError ? '无法更新对话列表' : '',
    setLocalConversations,
    rememberConversation,
    refreshLibrary,
    forgetConversation,
  };
}
