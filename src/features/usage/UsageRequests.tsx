import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api } from '../../platform/api';
import { formatAmount } from '../../../shared/usage/pricing';
import { usageCsvHeader, usageCsvRow } from '../../../shared/usage/csv';
import { usageKindLabels, usageStatusLabels, type UsageRecord } from '../../../shared/usage/types';

type Page = { records: UsageRecord[]; cursor: string | null };
export const money = (currencies: Record<string, string>) =>
  Object.entries(currencies)
    .map(([currency, amount]) => `${currency} ${formatAmount(amount)}`)
    .join(' · ') || '—';
export function RecordCost({ record }: { record: UsageRecord }) {
  const amount = record.cost.amount;
  return (
    <span>
      {amount === null ? '未定价' : `${record.cost.currency} ${formatAmount(amount)}`}
      {record.cost.state === 'partial'
        ? '（部分）'
        : record.cost.state === 'invalid'
          ? '（用量异常）'
          : ''}
    </span>
  );
}
type Locate = ((conversationId: string, messageId: string) => void) | undefined;
function RequestDetails({ record, onLocate }: { record: UsageRecord; onLocate: Locate }) {
  return (
    <details className="py-2">
      <summary className="cursor-pointer text-xs">
        {new Date(record.startedAt).toLocaleString()} · {usageKindLabels[record.kind]} ·{' '}
        {record.providerName} · {record.modelName}
      </summary>
      <div className="space-y-2 pt-2 text-xs">
        <p>
          {usageStatusLabels[record.status]} ·{' '}
          {record.usageIsFinal ? '供应商最终用量' : '用量不完整'} · <RecordCost record={record} />
        </p>
        <p>
          输入 {record.usage.inputTokens ?? '未知'} · 输出 {record.usage.outputTokens ?? '未知'} ·
          缓存读取 {record.usage.cachedInputTokens ?? '未知'}
        </p>
        <p>
          {record.model} · {record.protocol}
          {record.httpStatus ? ` · HTTP ${record.httpStatus}` : ''}
        </p>
        {record.endedAt !== null && (
          <p>
            耗时 {((record.endedAt - record.startedAt) / 1000).toFixed(2)} s
            {record.firstTokenMs !== undefined
              ? ` · 首字 ${(record.firstTokenMs / 1000).toFixed(2)} s`
              : ''}
          </p>
        )}
        {record.price && (
          <p>
            采用价格：{new Date(record.price.effectiveFrom).toLocaleString()} · 估算{' '}
            {record.cost.amount === null ? '未知' : formatAmount(record.cost.amount)}
          </p>
        )}
        {record.conversationId && record.messageId && (
          <a
            className="inline-flex min-h-8 items-center text-foreground underline decoration-primary underline-offset-2"
            href={`/c/${encodeURIComponent(record.conversationId)}?branch=${encodeURIComponent(record.messageId)}`}
            onClick={(event) => {
              if (
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey &&
                onLocate
              ) {
                event.preventDefault();
                onLocate(record.conversationId!, record.messageId!);
              }
            }}
          >
            定位回答
          </a>
        )}
      </div>
    </details>
  );
}
export function UsageRequests({ params, onLocate }: { params: string; onLocate: Locate }) {
  const query = useInfiniteQuery({
    queryKey: ['usage', 'requests', params],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<Page>(
        `/usage/requests?${params}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  const exportAbort = useRef<AbortController | null>(null),
    [exported, setExported] = useState<number | null>(null),
    [error, setError] = useState('');
  useEffect(() => () => exportAbort.current?.abort(), [params]);
  const download = async () => {
    const abort = new AbortController();
    exportAbort.current = abort;
    setExported(0);
    setError('');
    try {
      const parts: string[] = ['\ufeff', usageCsvHeader];
      let cursor: string | null = null,
        count = 0;
      do {
        const page: Page = await api(
          `/usage/requests?${params}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'GET',
          undefined,
          abort.signal,
        );
        parts.push(...page.records.map(usageCsvRow));
        count += page.records.length;
        setExported(count);
        cursor = page.cursor;
      } while (cursor);
      abort.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `EverChat-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : '导出失败。');
    } finally {
      if (exportAbort.current === abort) {
        exportAbort.current = null;
        setExported(null);
      }
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => void download()} disabled={exported !== null}>
          导出 CSV
        </Button>
        {exported !== null && (
          <>
            <span role="status" className="text-xs">
              已读取 {exported} 条
            </span>
            <Button variant="ghost" onClick={() => exportAbort.current?.abort()}>
              取消
            </Button>
          </>
        )}
      </div>
      {(query.error || error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || query.error?.message}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="text-sm">
          读取中…
        </p>
      )}
      <div className="divide-y divide-border">
        {query.data?.pages
          .flatMap((p) => p.records)
          .map((record) => (
            <RequestDetails key={record.id} record={record} onLocate={onLocate} />
          ))}
      </div>
      {query.data?.pages[0]?.records.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无请求</p>
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多
        </Button>
      )}
    </div>
  );
}
