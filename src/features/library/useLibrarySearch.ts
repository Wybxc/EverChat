import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { LibrarySearch as SearchPage } from '../../../shared/search/query';
import { api } from '../../platform/api';
import { deletedAt } from '../chat/cache';

export function useLibrarySearch(query: string) {
  const [debounced, setDebounced] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const search = useInfiniteQuery({
    queryKey: ['body-search', debounced],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<SearchPage>(
        `/search?${new URLSearchParams({ q: debounced, ...(pageParam ? { cursor: pageParam } : {}) })}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (page) => page.cursor ?? undefined,
    enabled: Boolean(debounced && debounced === query.trim() && online),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.indexing) ? 3000 : false,
  });
  const ready = debounced === query.trim();
  const pages = ready ? search.data?.pages : undefined;
  const results =
    pages?.flatMap((page) => page.results).filter((result) => !deletedAt(result.conversationId)) ??
    [];
  return { debounced, online, search, ready, pages, results };
}
