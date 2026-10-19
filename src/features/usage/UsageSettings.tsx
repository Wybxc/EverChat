import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderSettings } from '../../../shared/providers/types';
import { formatAmount } from '../../../shared/usage/pricing';
import {
  usageKinds,
  usageStatuses,
  type UsageGroup,
  type UsageReport,
} from '../../../shared/usage/types';
import { api } from '../../platform/api';
import { formatDateTime, formatNumber } from '../../platform/i18n/format';
import { errorMessage, renderUiMessage } from '../../platform/i18n/messages';
import { usageKindLabel, usageStatusLabel } from './labels';
import './locales';
import { ModelPriceButton } from './PriceEditor';
import { UsageChart } from './UsageChart';
import { money, UsageRequests } from './UsageRequests';

type Dimension = { providerId: string; providerName: string; model: string; modelName: string };
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const number = formatNumber;
function startDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days + 1);
  return localDate(date);
}
function GroupTable({ rows }: { rows: UsageGroup[] }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            {[
              t(($) => $.providerModel),
              t(($) => $.requestColumn),
              t(($) => $.inputOutput),
              t(($) => $.cacheHitRate),
              t(($) => $.estimatedCost),
              t(($) => $.averageEstimate),
              t(($) => $.successRate),
              t(($) => $.averageTime),
            ].map((label) => (
              <th key={label} className="whitespace-nowrap py-2 pr-4 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="min-w-36 py-2 pr-4">{row.label}</td>
              <td className="pr-4">{number(row.requests)}</td>
              <td className="whitespace-nowrap pr-4">
                {number(row.inputTokens)} / {number(row.outputTokens)}
              </td>
              <td className="pr-4">
                {row.cacheEligibleInputTokens
                  ? `${formatNumber((100 * row.cacheReportedReadTokens) / row.cacheEligibleInputTokens, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
                  : '—'}
              </td>
              <td className="min-w-32 pr-4">
                {money(row.currencies)}
                {row.unpriced > 0 && (
                  <span className="block text-muted-foreground">
                    {t(($) => $.unpricedCount, { count: row.unpriced })}
                  </span>
                )}
              </td>
              <td className="min-w-32 pr-4" title={t(($) => $.averageHint)}>
                {row.requests
                  ? Object.entries(row.currencies)
                      .map(
                        ([currency, amount]) =>
                          `${currency} ${formatAmount((BigInt(amount) / BigInt(row.requests)).toString())}`,
                      )
                      .join(' · ') || '—'
                  : '—'}
              </td>
              <td className="pr-4">
                {row.requests
                  ? `${formatNumber((100 * row.completed) / row.requests, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
                  : '—'}
              </td>
              <td className="min-w-36">
                {row.firstTokenSamples
                  ? t(($) => $.sampleTime, {
                      seconds: formatNumber(row.firstTokenMs / row.firstTokenSamples / 1000, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }),
                      count: row.firstTokenSamples,
                    })
                  : '—'}{' '}
                /{' '}
                {row.durationSamples
                  ? t(($) => $.sampleTime, {
                      seconds: formatNumber(row.durationMs / row.durationSamples / 1000, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }),
                      count: row.durationSamples,
                    })
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="py-3 text-sm text-muted-foreground">{t(($) => $.empty)}</p>}
    </div>
  );
}
function Pricing({ dimensions }: { dimensions: Dimension[] }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  const query = useQuery({
    queryKey: ['provider-settings'],
    queryFn: () => api<ProviderSettings>('/settings/providers'),
  });
  const rows = new Map(dimensions.map((d) => [`${d.providerId}:${d.model}`, d]));
  for (const provider of query.data?.providers ?? [])
    for (const model of provider.models)
      rows.set(`${provider.id}:${model.id}`, {
        providerId: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name || model.id,
      });
  for (const provider of ['deepseek', 'tavily'])
    for (const model of ['web_search', 'read_webpage'])
      rows.set(`web:${provider}:${model}`, {
        providerId: `web:${provider}`,
        providerName: provider === 'deepseek' ? t(($) => $.deepseekWeb) : 'Tavily',
        model,
        modelName: model === 'web_search' ? t(($) => $.webSearch) : t(($) => $.webFetch),
      });
  return (
    <div className="divide-y divide-border">
      {query.error && <p role="alert">{renderUiMessage(errorMessage(query.error))}</p>}
      {[...rows.values()].map((row) => (
        <div
          key={`${row.providerId}:${row.model}`}
          className="flex items-center justify-between gap-2 py-2 text-sm"
        >
          <span className="min-w-0 break-words">
            {row.providerName} · {row.modelName}
          </span>
          <ModelPriceButton providerId={row.providerId} model={row.model} />
        </div>
      ))}
    </div>
  );
}

export default function UsageSettings({
  onLocate,
}: {
  onLocate?: (conversationId: string, messageId: string) => void;
}) {
  const { t } = useTranslation('usage', { useSuspense: false });

  const [tab, setTab] = useState('overview'),
    [days, setDays] = useState('30'),
    [from, setFrom] = useState(() => startDate(30)),
    [to, setTo] = useState(() => localDate(new Date()));
  const [provider, setProvider] = useState(''),
    [model, setModel] = useState(''),
    [kind, setKind] = useState(''),
    [status, setStatus] = useState(''),
    [interval, setInterval] = useState('day');
  const dimensions = useQuery({
    queryKey: ['usage', 'dimensions'],
    queryFn: () => api<Dimension[]>('/usage/dimensions'),
    refetchOnWindowFocus: false,
  });
  const params = useMemo(() => {
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return new URLSearchParams({
      from: String(new Date(`${from}T00:00:00`).getTime()),
      to: String(end.getTime()),
      ...(provider ? { providerId: provider } : {}),
      ...(model ? { model } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
    }).toString();
  }, [from, to, provider, model, kind, status]);
  const report = useQuery({
    queryKey: ['usage', 'report', params, interval],
    queryFn: ({ signal }) =>
      api<UsageReport>(
        `/usage/report?${params}&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}&interval=${interval}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: tab !== 'pricing',
    refetchOnWindowFocus: false,
  });
  const providers = [...new Map((dimensions.data ?? []).map((d) => [d.providerId, d])).values()];
  const models = (dimensions.data ?? []).filter((d) => !provider || d.providerId === provider);
  const totals = report.data?.totals,
    client = useQueryClient();
  return (
    <div className="min-w-0 space-y-2">
      <div data-testid="usage-tab-header" className="sticky top-0 z-10 bg-popover pb-2">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList
            variant="line"
            className="max-w-full justify-start overflow-x-auto"
            aria-label={t(($) => $.tabs)}
          >
            {[
              ['overview', t(($) => $.overview)],
              ['providers', t(($) => $.providers)],
              ['models', t(($) => $.models)],
              ['requests', t(($) => $.requestColumn)],
              ['pricing', t(($) => $.pricing)],
            ].map(([id, label]) => (
              <TabsTrigger
                key={id}
                value={id}
                id={`usage-tab-${id}`}
                aria-controls={`usage-panel-${id}`}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div
        role="tabpanel"
        id={`usage-panel-${tab}`}
        aria-labelledby={`usage-tab-${tab}`}
        className="min-w-0 pb-4"
      >
        {tab !== 'pricing' && (
          <div className="flex flex-wrap items-end gap-2 py-2">
            <NativeSelect
              aria-label={t(($) => $.timeRange)}
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                if (e.target.value !== 'custom') {
                  setFrom(startDate(Number(e.target.value)));
                  setTo(localDate(new Date()));
                }
              }}
            >
              <option value="1">{t(($) => $.today)}</option>
              <option value="7">{t(($) => $.last7days)}</option>
              <option value="30">{t(($) => $.last30days)}</option>
              <option value="custom">{t(($) => $.custom)}</option>
            </NativeSelect>
            {days === 'custom' && (
              <>
                <label className="text-xs">
                  {t(($) => $.from)}
                  <Input
                    type="date"
                    aria-label={t(($) => $.from)}
                    required
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="text-xs">
                  {t(($) => $.to)}
                  <Input
                    type="date"
                    aria-label={t(($) => $.to)}
                    min={from}
                    required
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </>
            )}
            <NativeSelect
              aria-label={t(($) => $.filterProvider)}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel('');
              }}
            >
              <option value="">{t(($) => $.allProviders)}</option>
              {providers.map((d) => (
                <option key={d.providerId} value={d.providerId}>
                  {d.providerName}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t(($) => $.filterModel)}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{t(($) => $.allModels)}</option>
              {[...new Map(models.map((d) => [d.model, d])).values()].map((d) => (
                <option key={d.model} value={d.model}>
                  {d.modelName}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t(($) => $.requestKind)}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">{t(($) => $.allKinds)}</option>
              {usageKinds.map((k) => (
                <option key={k} value={k}>
                  {usageKindLabel(k)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t(($) => $.requestStatus)}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t(($) => $.allStatuses)}</option>
              {usageStatuses.map((s) => (
                <option key={s} value={s}>
                  {usageStatusLabel(s)}
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="ghost"
              onClick={() => void client.invalidateQueries({ queryKey: ['usage'] })}
            >
              {t(($) => $.refresh)}
            </Button>
          </div>
        )}
        {tab !== 'pricing' && report.isPending && (
          <p role="status" className="py-4 text-sm">
            {t(($) => $.loading)}
          </p>
        )}
        {(report.error || dimensions.error) && (
          <p role="alert" className="py-2 text-sm text-destructive">
            {renderUiMessage(errorMessage(report.error || dimensions.error))}
          </p>
        )}
        {tab === 'overview' && totals && (
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t(($) => $.calculatedEstimate), money(totals.currencies)],
                [
                  t(($) => $.modelRequestsAnswers),
                  `${number(totals.modelRequests)} / ${number(totals.answers)}`,
                ],
                [
                  t(($) => $.inputOutput),
                  `${number(totals.inputTokens)} / ${number(totals.outputTokens)}`,
                ],
                [
                  t(($) => $.successRate),
                  totals.requests
                    ? `${formatNumber((100 * totals.completed) / totals.requests, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
                    : '—',
                ],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-lg bg-muted p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="break-words pt-1 text-sm font-medium">{value}</p>
                </div>
              ))}
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer">
                {t(($) => $.incompleteCounts, {
                  unpriced: totals.unpriced,
                  incomplete: totals.incomplete,
                })}
              </summary>
              <p className="pt-2">
                {t(($) => $.cacheTotals, {
                  read: number(totals.cachedInputTokens),
                  write: number(totals.cacheWriteInputTokens),
                  requests: number(totals.requests),
                })}
              </p>
            </details>
            <NativeSelect
              aria-label={t(($) => $.trendInterval)}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              <option value="day">{t(($) => $.daily)}</option>
              <option value="hour">{t(($) => $.hourly)}</option>
            </NativeSelect>
            <UsageChart points={report.data!.trend} />
            <p className="text-xs text-muted-foreground">
              {report.data!.collectedSince
                ? t(($) => $.collectedSince, {
                    date: formatDateTime(report.data!.collectedSince, {
                      dateStyle: 'medium',
                      timeStyle: 'medium',
                    }),
                  })
                : t(($) => $.firstRequest)}{' '}
              {t(($) => $.estimateHint)}
            </p>
          </div>
        )}
        {tab === 'providers' && <GroupTable rows={report.data?.providers ?? []} />}
        {tab === 'models' && <GroupTable rows={report.data?.models ?? []} />}
        {tab === 'requests' && <UsageRequests params={params} onLocate={onLocate} />}
        {tab === 'pricing' && <Pricing dimensions={dimensions.data ?? []} />}
      </div>
    </div>
  );
}
