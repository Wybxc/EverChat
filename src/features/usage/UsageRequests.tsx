import { Button } from '@/components/ui/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAmount } from '../../../shared/usage/pricing';
import type { UsageRecord } from '../../../shared/usage/types';
import { api } from '../../platform/api';
import { formatDateTime, formatNumber } from '../../platform/i18n/format';
import {
  type UiMessage,
  errorMessage,
  renderUiMessage,
  uiMessage,
} from '../../platform/i18n/messages';
import { csvLabels, usageCsvHeader, usageCsvRow } from './csv';
import { usageKindLabel, usageStatusLabel } from './labels';
import './locales';

type Page = { records: UsageRecord[]; cursor: string | null };
export const money = (currencies: Record<string, string>) =>
  Object.entries(currencies)
    .map(([currency, amount]) => `${currency} ${formatAmount(amount)}`)
    .join(' · ') || '—';
export function RecordCost({ record }: { record: UsageRecord }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  const amount = record.cost.amount;
  return (
    <span>
      {amount === null ? t(($) => $.unpriced) : `${record.cost.currency} ${formatAmount(amount)}`}
      {record.cost.state === 'partial'
        ? t(($) => $.partial)
        : record.cost.state === 'invalid'
          ? t(($) => $.invalidUsage)
          : ''}
    </span>
  );
}
type Locate = ((conversationId: string, messageId: string) => void) | undefined;
function RequestDetails({ record, onLocate }: { record: UsageRecord; onLocate: Locate }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  return (
    <details className="py-2">
      <summary className="cursor-pointer text-xs">
        {formatDateTime(record.startedAt, { dateStyle: 'medium', timeStyle: 'medium' })} ·{' '}
        {usageKindLabel(record.kind)} · {record.providerName} · {record.modelName}
      </summary>
      <div className="space-y-2 pt-2 text-xs">
        <p>
          {usageStatusLabel(record.status)} ·{' '}
          {record.usageIsFinal ? t(($) => $.finalUsage) : t(($) => $.incompleteUsage)} ·{' '}
          <RecordCost record={record} />
        </p>
        <p>
          {t(($) => $.usageDetails, {
            input:
              record.usage.inputTokens === undefined
                ? t(($) => $.unknown)
                : formatNumber(record.usage.inputTokens),
            output:
              record.usage.outputTokens === undefined
                ? t(($) => $.unknown)
                : formatNumber(record.usage.outputTokens),
            cache:
              record.usage.cachedInputTokens === undefined
                ? t(($) => $.unknown)
                : formatNumber(record.usage.cachedInputTokens),
          })}
        </p>
        <p>
          {record.model} · {record.protocol}
          {record.httpStatus ? ` · HTTP ${record.httpStatus}` : ''}
        </p>
        {record.endedAt !== null && (
          <p>
            {t(($) => $.duration, {
              seconds: formatNumber((record.endedAt - record.startedAt) / 1000, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            })}
            {record.firstTokenMs !== undefined
              ? t(($) => $.firstToken, {
                  seconds: formatNumber(record.firstTokenMs / 1000, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }),
                })
              : ''}
          </p>
        )}
        {record.price && (
          <p>
            {t(($) => $.priceUsed, {
              date: formatDateTime(record.price.effectiveFrom, {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
              amount:
                record.cost.amount === null
                  ? t(($) => $.unknown)
                  : formatAmount(record.cost.amount),
            })}
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
            {t(($) => $.locate)}
          </a>
        )}
      </div>
    </details>
  );
}
export function UsageRequests({ params, onLocate }: { params: string; onLocate: Locate }) {
  const { t } = useTranslation('usage', { useSuspense: false });

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
    [error, setError] = useState<UiMessage>('');
  useEffect(() => () => exportAbort.current?.abort(), [params]);
  const download = async () => {
    const abort = new AbortController();
    exportAbort.current = abort;
    setExported(0);
    setError('');
    try {
      const labels = csvLabels(); // Pin export labels even if the UI language changes mid-download.
      const parts: string[] = ['\ufeff', usageCsvHeader(labels)];
      let cursor: string | null = null,
        count = 0;
      do {
        const page: Page = await api(
          `/usage/requests?${params}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'GET',
          undefined,
          abort.signal,
        );
        parts.push(...page.records.map((record) => usageCsvRow(record, labels)));
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
        setError(errorMessage(failure, uiMessage('usage', 'exportFailed')));
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
          {t(($) => $.exportCsv)}
        </Button>
        {exported !== null && (
          <>
            <span role="status" className="text-xs">
              {t(($) => $.exportedCount, { count: exported })}
            </span>
            <Button variant="ghost" onClick={() => exportAbort.current?.abort()}>
              {t(($) => $.cancel)}
            </Button>
          </>
        )}
      </div>
      {(query.error || error) && (
        <p role="alert" className="text-sm text-destructive">
          {renderUiMessage(error || errorMessage(query.error))}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="text-sm">
          {t(($) => $.loading)}
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
        <p className="text-sm text-muted-foreground">{t(($) => $.noRequests)}</p>
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t(($) => $.loadMore)}
        </Button>
      )}
    </div>
  );
}
