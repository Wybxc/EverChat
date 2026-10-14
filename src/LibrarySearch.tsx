import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from './api';
import { conversationUrl } from './useConversationRoute';
import type { LibrarySearch as SearchPage, SearchResult } from '../shared/search';
import { deletedAt } from './storage';

export function LibrarySearch({ query, archived, open }: { query: string; archived: boolean; open: (result: SearchResult, query: string) => void }) {
  const [debounced, setDebounced] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 350); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const search = useInfiniteQuery({
    queryKey: ['body-search', debounced, archived], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<SearchPage>(`/search?${new URLSearchParams({ q: debounced, archived: String(archived), ...(pageParam ? { cursor: pageParam } : {}) })}`),
    getNextPageParam: (page) => page.cursor ?? undefined,
    enabled: Boolean(debounced && debounced === query.trim() && online), retry: false, staleTime: 0,
    refetchInterval: (query) => query.state.data?.pages.some((page) => page.indexing) ? 3000 : false,
  });
  const ready = debounced === query.trim();
  const pages = ready ? search.data?.pages : undefined;
  return <section aria-label="正文搜索结果" className="mt-4">
    <p className="px-3 pb-2 text-xs font-medium">正文与思考</p>
    {!online ? <p role="status" className="px-3 text-xs text-base-content/60">联网后搜索正文</p>
      : !ready || search.isPending ? <p role="status" className="px-3 text-xs"><span className="loading loading-dots loading-xs" aria-hidden="true" /> 搜索中</p>
      : null}
    {pages && <ul className="menu w-full gap-1 p-0 text-sm">{pages.flatMap((page) => page.results).filter((result) => !deletedAt(result.conversationId)).map((result) => <li key={`${result.conversationId}:${result.messageId}:${result.field}`}><a href={conversationUrl(result.conversationId)} className="block min-w-0 rounded-lg px-3 py-2" onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); open(result, debounced);
    }}><span className="block truncate text-xs font-medium">{result.title} · {result.field === 'reasoning' ? '思考' : '正文'}</span><span className="mt-1 block line-clamp-3 break-words text-xs text-base-content/60">{result.excerpt}</span></a></li>)}</ul>}
    {pages && !pages.some((page) => page.results.length) && <p role="status" className="px-3 text-xs text-base-content/60">没有正文匹配</p>}
    {pages?.some((page) => page.indexing) && <p role="status" className="mt-2 px-3 text-xs text-base-content/60">索引更新中</p>}
    {pages?.at(-1)?.error && <p role="alert" className="mt-2 px-3 text-xs">{pages.at(-1)!.error}</p>}
    {search.error && ready && <div role="alert" className="space-y-2 px-3 text-xs"><p>{search.error.message}</p><button className="btn btn-sm" onClick={() => { void search.refetch(); }}>重新搜索</button></div>}
    {ready && search.hasNextPage && <button type="button" className="btn btn-ghost btn-sm mt-2 w-full" disabled={search.isFetchingNextPage || !online} onClick={() => { void search.fetchNextPage(); }}>{search.isFetchingNextPage ? '加载中…' : '加载更多结果'}</button>}
  </section>;
}
