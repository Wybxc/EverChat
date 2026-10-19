import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../platform/api';
import { conversationUrl } from '../../app/useConversationRoute';
import type { LibrarySearch as SearchPage, SearchResult } from '../../../shared/search/query';
import { deletedAt } from '../chat/cache';
import { SearchResultItem } from './SearchResultItem';
import { SearchHighlight } from './SearchHighlight';

export function LibrarySearch({
  query,
  open,
}: {
  query: string;
  open: (result: SearchResult, query: string) => void;
}) {
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
  return (
    <section aria-label="正文搜索结果" className="mt-4">
      <p className="px-3 pb-2 text-xs font-medium">正文与思考</p>
      {!online ? (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          联网后搜索正文
        </p>
      ) : !ready || search.isPending ? (
        <p role="status" className="px-3 text-xs">
          <Spinner aria-hidden="true" /> 搜索中
        </p>
      ) : null}
      {pages && (
        <ul className="w-full space-y-1 p-0 text-sm">
          {pages
            .flatMap((page) => page.results)
            .filter((result) => !deletedAt(result.conversationId))
            .map((result) => (
              <li key={`${result.conversationId}:${result.messageId}:${result.field}`}>
                <SearchResultItem
                  value={`body:${result.conversationId}:${result.messageId}:${result.field}`}
                  href={conversationUrl(result.conversationId, result.messageId)}
                  open={() => open(result, debounced)}
                >
                  <span className="block truncate text-xs font-medium">
                    <SearchHighlight text={result.title} query={debounced} /> ·{' '}
                    {result.field === 'reasoning' ? '思考' : '正文'}
                  </span>
                  <span className="mt-1 block line-clamp-3 break-words text-xs text-muted-foreground">
                    <SearchHighlight text={result.excerpt} query={debounced} />
                  </span>
                </SearchResultItem>
              </li>
            ))}
        </ul>
      )}
      {pages && !pages.some((page) => page.results.length) && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          没有正文匹配
        </p>
      )}
      {pages?.some((page) => page.indexing) && (
        <p role="status" className="mt-2 px-3 text-xs text-muted-foreground">
          索引更新中
        </p>
      )}
      {pages?.at(-1)?.error && (
        <p role="alert" className="mt-2 px-3 text-xs">
          {pages.at(-1)!.error}
        </p>
      )}
      {search.error && ready && (
        <div role="alert" className="space-y-2 px-3 text-xs">
          <p>{search.error.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void search.refetch();
            }}
          >
            重新搜索
          </Button>
        </div>
      )}
      {ready && search.hasNextPage && (
        <Button
          variant="ghost"
          type="button"
          className="mt-2 w-full"
          disabled={search.isFetchingNextPage || !online}
          onClick={() => {
            void search.fetchNextPage();
          }}
        >
          {search.isFetchingNextPage ? '加载中…' : '加载更多结果'}
        </Button>
      )}
    </section>
  );
}
