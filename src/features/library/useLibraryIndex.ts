import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  mergeActivity,
  type ActivityIndex,
  type ConversationActivity,
} from '../../../shared/conversation/activity';
import type { ConversationInfo, LibrarySnapshot } from '../../../shared/conversation/types';
import { ApiError } from '../../platform/api';
import { coversLibraryVersion } from '../../../shared/library/protocol';
import { controlSnapshot, subscribeControl } from '../../platform/sync/control';
import { syncRetryDelay } from '../../platform/sync/backoff';
import { loadLibraryIndex } from './index-cache';
import { uiMessage } from '../../platform/i18n/messages';
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
  const baseline = useRef(read<LibrarySnapshot | null>('library-index', null));
  const control = useSyncExternalStore(subscribeControl, controlSnapshot);
  const lastAttempt = useRef('');
  const deletionCallback = useRef(onDeleted);
  deletionCallback.current = onDeleted;
  const [localConversations, setLocalConversations] = useState<ConversationInfo[]>(
    () => baseline.current?.conversations ?? [],
  );
  const [activities, setActivities] = useState<ActivityIndex>(
    () => baseline.current?.activity ?? {},
  );
  const activityRef = useRef(activities);
  const cacheEpoch = storageEpoch();
  const baselineEpoch = useRef(cacheEpoch);
  useEffect(() => {
    if (baselineEpoch.current === cacheEpoch) return;
    baselineEpoch.current = cacheEpoch;
    baseline.current = null;
    lastAttempt.current = '';
    activityRef.current = {};
    setActivities({});
    setLocalConversations([]);
  }, [cacheEpoch]);
  const observeActivity = useCallback((id: string, activity: ConversationActivity) => {
    if (deletedAt(id)) return;
    const previous = activityRef.current;
    const next = mergeActivity(previous, id, activity);
    if (next !== previous) {
      activityRef.current = next;
      setActivities(next);
    }
  }, []);
  const libraryQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async ({ signal }) => {
      const epoch = storageEpoch();
      const page = await loadLibraryIndex(baseline.current, signal);
      if (epoch !== storageEpoch()) throw new DOMException('Session changed', 'AbortError');
      for (const deletion of page.deletions)
        deletionCallback.current(deletion.id, deletion.deletedAt);
      if (baseline.current && baseline.current.watermark.epoch !== page.watermark.epoch) {
        activityRef.current = page.activity;
        setActivities(page.activity);
      } else
        for (const [id, activity] of Object.entries(page.activity)) observeActivity(id, activity);
      // Keep the list, activity, cursor and watermark in one recoverable value.
      baseline.current = { ...page, deletions: [] };
      write('library-index', baseline.current);
      return page.conversations;
    },
    enabled: enabled,
    initialData: () => baseline.current?.conversations,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (count, error) =>
      count < 2 && (!(error instanceof ApiError) || error.status === 429 || error.status >= 500),
    retryDelay: (attempt) => syncRetryDelay(attempt + 2),
  });
  useEffect(() => {
    if (!enabled || !control.ready || !control.watermark || libraryQuery.isFetching) return;
    if (coversLibraryVersion(baseline.current?.watermark, control.watermark)) return;
    const target = JSON.stringify([control.connection, control.watermark]);
    if (libraryQuery.isError && lastAttempt.current === target) return;
    lastAttempt.current = target;
    void libraryQuery.refetch({ cancelRefetch: false });
  }, [
    enabled,
    control,
    libraryQuery.isFetching,
    libraryQuery.isError,
    libraryQuery.dataUpdatedAt,
    libraryQuery.refetch,
  ]);
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
    }
  }, [enabled, libraryQuery.data, libraryQuery.error, onUnauthorized]);
  const refreshLibrary = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] }, { cancelRefetch: false });
    void queryClient.invalidateQueries({ queryKey: ['body-search'] });
  }, [queryClient]);

  const forgetConversation = useCallback(
    (id: string) => {
      const next = { ...activityRef.current };
      delete next[id];
      activityRef.current = next;
      setActivities(next);
      setLocalConversations((items) => items.filter((item) => item.id !== id));
      queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) =>
        items?.filter((item) => item.id !== id),
      );
    },
    [queryClient],
  );
  const rememberConversation = (conversation: ConversationInfo) => {
    const items = [conversation, ...localConversations];
    setLocalConversations(items);
  };
  return {
    conversations,
    activities,
    observeActivity,
    activityFresh: (_id: string) =>
      control.ready &&
      !libraryQuery.isError &&
      Boolean(
        control.watermark && coversLibraryVersion(baseline.current?.watermark, control.watermark),
      ),
    savedIds: new Set((libraryQuery.data ?? []).map((item) => item.id)),
    libraryLoading: !conversations.length && libraryQuery.isLoading,
    libraryError: libraryQuery.isError || control.error ? uiMessage('library', 'updateFailed') : '',
    setLocalConversations,
    rememberConversation,
    refreshLibrary,
    forgetConversation,
  };
}
