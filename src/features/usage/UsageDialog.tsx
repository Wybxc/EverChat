import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import type { ProviderSettings } from '../../../shared/providers/types';
import {
  usageKinds,
  usageStatuses,
  usageKindLabels,
  usageStatusLabels,
  type UsageGroup,
  type UsageReport,
} from '../../../shared/usage/types';
import { UsageChart } from './UsageChart';
import { money, UsageRequests } from './UsageRequests';
import { ModelPriceButton } from './PriceEditor';
import { formatAmount } from '../../../shared/usage/pricing';

type Dimension = { providerId: string; providerName: string; model: string; modelName: string };
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
function startDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days + 1);
  return localDate(date);
}
function GroupTable({ rows }: { rows: UsageGroup[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            {[
              '供应商／模型',
              '请求',
              '输入／输出 Token',
              '缓存命中率',
              '估算费用',
              '平均估算',
              '成功率',
              '平均首字／耗时',
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
                  ? `${((100 * row.cacheReportedReadTokens) / row.cacheEligibleInputTokens).toFixed(1)}%`
                  : '—'}
              </td>
              <td className="min-w-32 pr-4">
                {money(row.currencies)}
                {row.unpriced > 0 && (
                  <span className="block text-muted-foreground">{row.unpriced} 项费用不完整</span>
                )}
              </td>
              <td
                className="min-w-32 pr-4"
                title="可计算部分除以总请求数；用量或定价不完整时可能低估。"
              >
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
                {row.requests ? `${((100 * row.completed) / row.requests).toFixed(1)}%` : '—'}
              </td>
              <td className="min-w-36">
                {row.firstTokenSamples
                  ? `${(row.firstTokenMs / row.firstTokenSamples / 1000).toFixed(2)} s（${row.firstTokenSamples}）`
                  : '—'}{' '}
                /{' '}
                {row.durationSamples
                  ? `${(row.durationMs / row.durationSamples / 1000).toFixed(2)} s（${row.durationSamples}）`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="py-3 text-sm text-muted-foreground">暂无数据</p>}
    </div>
  );
}
function Pricing({ dimensions }: { dimensions: Dimension[] }) {
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
        providerName: provider === 'deepseek' ? 'DeepSeek 联网' : 'Tavily',
        model,
        modelName: model === 'web_search' ? '网页搜索' : '网页读取',
      });
  return (
    <div className="divide-y divide-border">
      {query.error && <p role="alert">{query.error.message}</p>}
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

export default function UsageDialog({
  open,
  onOpenChange,
  onLocate,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onLocate: (conversationId: string, messageId: string) => void;
}) {
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
    enabled: open,
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
    enabled: open && tab !== 'pricing',
    refetchOnWindowFocus: false,
  });
  const providers = [...new Map((dimensions.data ?? []).map((d) => [d.providerId, d])).values()];
  const models = (dimensions.data ?? []).filter((d) => !provider || d.providerId === provider);
  const totals = report.data?.totals,
    client = useQueryClient();
  return (
    <Modal open={open} onOpenChange={onOpenChange} showCloseButton>
      <div className="flex max-h-[calc(100dvh-2rem)] w-[calc(100dvw-2rem)] max-w-5xl flex-col overflow-hidden p-0">
        <div className="shrink-0 space-y-3 px-4 pt-4 pb-2 pr-12">
          <ModalTitle>用量统计</ModalTitle>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="max-w-full overflow-x-auto" aria-label="统计分类">
              {[
                ['overview', '概览'],
                ['providers', '供应商'],
                ['models', '模型'],
                ['requests', '请求'],
                ['pricing', '定价'],
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
          className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4"
        >
          {tab !== 'pricing' && (
            <div className="flex flex-wrap items-end gap-2 py-2">
              <NativeSelect
                aria-label="统计时间范围"
                value={days}
                onChange={(e) => {
                  setDays(e.target.value);
                  if (e.target.value !== 'custom') {
                    setFrom(startDate(Number(e.target.value)));
                    setTo(localDate(new Date()));
                  }
                }}
              >
                <option value="1">今日</option>
                <option value="7">近 7 日</option>
                <option value="30">近 30 日</option>
                <option value="custom">自定义</option>
              </NativeSelect>
              {days === 'custom' && (
                <>
                  <label className="text-xs">
                    开始日期
                    <Input
                      type="date"
                      aria-label="开始日期"
                      required
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label className="text-xs">
                    结束日期
                    <Input
                      type="date"
                      aria-label="结束日期"
                      min={from}
                      required
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </>
              )}
              <NativeSelect
                aria-label="统计供应商"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel('');
                }}
              >
                <option value="">全部供应商</option>
                {providers.map((d) => (
                  <option key={d.providerId} value={d.providerId}>
                    {d.providerName}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="统计模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">全部模型</option>
                {[...new Map(models.map((d) => [d.model, d])).values()].map((d) => (
                  <option key={d.model} value={d.model}>
                    {d.modelName}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="请求类型"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">全部类型</option>
                {usageKinds.map((k) => (
                  <option key={k} value={k}>
                    {usageKindLabels[k]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="请求状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">全部状态</option>
                {usageStatuses.map((s) => (
                  <option key={s} value={s}>
                    {usageStatusLabels[s]}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="ghost"
                onClick={() => void client.invalidateQueries({ queryKey: ['usage'] })}
              >
                刷新
              </Button>
            </div>
          )}
          {tab !== 'pricing' && report.isPending && (
            <p role="status" className="py-4 text-sm">
              读取中…
            </p>
          )}
          {(report.error || dimensions.error) && (
            <p role="alert" className="py-2 text-sm text-destructive">
              {report.error?.message || dimensions.error?.message}
            </p>
          )}
          {tab === 'overview' && totals && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['可计算部分估算', money(totals.currencies)],
                  ['模型请求／回答', `${number(totals.modelRequests)} / ${number(totals.answers)}`],
                  [
                    '输入／输出 Token',
                    `${number(totals.inputTokens)} / ${number(totals.outputTokens)}`,
                  ],
                  [
                    '成功率',
                    totals.requests
                      ? `${((100 * totals.completed) / totals.requests).toFixed(1)}%`
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
                  费用不完整 {totals.unpriced} 项 · 用量不完整 {totals.incomplete} 项
                </summary>
                <p className="pt-2">
                  缓存读取 {number(totals.cachedInputTokens)} · 缓存写入{' '}
                  {number(totals.cacheWriteInputTokens)} · 总请求 {number(totals.requests)}
                </p>
              </details>
              <NativeSelect
                aria-label="趋势粒度"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="day">按日</option>
                <option value="hour">按小时</option>
              </NativeSelect>
              <UsageChart points={report.data!.trend} />
              <p className="text-xs text-muted-foreground">
                {report.data!.collectedSince
                  ? `记录始于 ${new Date(report.data!.collectedSince).toLocaleString()}。`
                  : '从首次请求开始记录。'}{' '}
                金额为估算，以供应商账单为准。
              </p>
            </div>
          )}
          {tab === 'providers' && <GroupTable rows={report.data?.providers ?? []} />}
          {tab === 'models' && <GroupTable rows={report.data?.models ?? []} />}
          {tab === 'requests' && <UsageRequests params={params} onLocate={onLocate} />}
          {tab === 'pricing' && <Pricing dimensions={dimensions.data ?? []} />}
        </div>
      </div>
    </Modal>
  );
}
