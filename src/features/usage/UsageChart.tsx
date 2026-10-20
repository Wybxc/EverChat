import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, Brush, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { NativeSelect } from '@/components/ui/native-select';
import { formatNumber, formatDateTime } from '../../platform/i18n/format';
import type { UsageGroup } from '../../../shared/usage/types';
import { formatAmount } from '../../../shared/usage/pricing';
import { chartCurrencies, comparisonRows, metricValue } from './chart-data';
import './locales';

function MetricSelector({
  currencies,
  value,
  onChange,
  label,
}: {
  currencies: string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { t } = useTranslation('usage');
  return (
    <NativeSelect aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="requests">{t(($) => $.requests)}</option>
      <option value="tokens">Token</option>
      {currencies.map((currency) => (
        <option key={currency} value={currency}>
          {t(($) => $.estimatedCurrency, { currency })}
        </option>
      ))}
    </NativeSelect>
  );
}

function InputSeriesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 8h16" stroke="var(--chart-1)" strokeWidth="2" />
    </svg>
  );
}
function OutputSeriesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 8h16" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="3 2" />
    </svg>
  );
}

export function UsageChart({ points }: { points: UsageGroup[] }) {
  const { t } = useTranslation('usage', { useSuspense: false });
  const [selectedMetric, setMetric] = useState('requests');
  const currencies = chartCurrencies(points);
  const metric = ['requests', 'tokens', ...currencies].includes(selectedMetric)
    ? selectedMetric
    : 'requests';
  const monetary = metric !== 'requests' && metric !== 'tokens';
  const config = {
    value: {
      label: monetary ? t(($) => $.estimatedCurrency, { currency: metric }) : t(($) => $.requests),
      color: 'var(--chart-1)',
    },
    inputTokens: { label: t(($) => $.csvInput), color: 'var(--chart-1)', icon: InputSeriesIcon },
    outputTokens: { label: t(($) => $.csvOutput), color: 'var(--chart-2)', icon: OutputSeriesIcon },
  } satisfies ChartConfig;
  const data = points.map((point) => ({ ...point, value: metricValue(point, metric) }));
  const hourly = points.some((point) => point.key.includes('GMT'));
  const date = (at: number) =>
    formatDateTime(at, {
      month: '2-digit',
      day: '2-digit',
      ...(hourly
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
        : { timeZone: 'UTC' }),
    });
  return (
    <figure className="flex min-w-0 flex-col gap-2" aria-label={t(($) => $.chart)}>
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm font-medium">{t(($) => $.trend)}</figcaption>
        <MetricSelector
          currencies={currencies}
          value={metric}
          onChange={setMetric}
          label={t(($) => $.trendMetric)}
        />
      </div>
      {points.length ? (
        <ChartContainer config={config} className="usage-chart h-64 min-w-0 w-full aspect-auto">
          <LineChart
            data={data}
            accessibilityLayer
            margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="at"
              domain={['dataMin', 'dataMax']}
              tickFormatter={date}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              width={48}
              tickFormatter={(value) =>
                formatNumber(
                  value,
                  monetary
                    ? { maximumSignificantDigits: 3 }
                    : { notation: 'compact', maximumFractionDigits: 2 },
                )
              }
              allowDecimals={monetary}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              isAnimationActive={false}
              cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, payload) =>
                    payload[0]?.payload.at === undefined ? '' : date(payload[0].payload.at)
                  }
                  formatter={(value, _name, entry) => (
                    <>
                      <span className="text-muted-foreground">
                        {config[entry.dataKey as keyof typeof config]?.label}
                      </span>
                      <span className="ml-auto font-mono tabular-nums">
                        {monetary
                          ? `${metric} ${formatAmount(entry.payload.currencies[metric])}${entry.payload.unpriced ? t(($) => $.partial) : ''}`
                          : metric === 'tokens'
                            ? `${formatNumber(Number(value))} Tokens`
                            : t(($) => $.requestCount, { count: Number(value) })}
                      </span>
                    </>
                  )}
                />
              }
            />
            {metric === 'tokens' ? (
              <>
                <Line
                  name="inputTokens"
                  dataKey="inputTokens"
                  type="linear"
                  stroke="var(--color-inputTokens)"
                  strokeWidth={2}
                  dot={points.length < 32 ? { r: 3, fill: 'var(--background)' } : false}
                  isAnimationActive={false}
                />
                <Line
                  name="outputTokens"
                  dataKey="outputTokens"
                  type="linear"
                  stroke="var(--color-outputTokens)"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={points.length < 32 ? { r: 2, fill: 'var(--color-outputTokens)' } : false}
                  isAnimationActive={false}
                />
                <ChartLegend content={<ChartLegendContent />} />
              </>
            ) : (
              <Line
                name="value"
                dataKey="value"
                type="linear"
                stroke="var(--color-value)"
                strokeWidth={2}
                dot={points.length < 32 ? { r: 3, fill: 'var(--background)' } : false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            )}
            {points.length > 7 && (
              <Brush
                dataKey="label"
                height={28}
                travellerWidth={10}
                tickFormatter={(value: string) => value.replace(/^\d{4}-/, '')}
                stroke="var(--chart-1)"
                fill="var(--muted)"
              />
            )}
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="text-xs text-muted-foreground">{t(($) => $.empty)}</p>
      )}
    </figure>
  );
}

export function UsageComparison({ rows, title }: { rows: UsageGroup[]; title: string }) {
  const { t } = useTranslation('usage');
  const [selectedMetric, setMetric] = useState('requests');
  const currencies = chartCurrencies(rows);
  const metric = ['requests', 'tokens', ...currencies].includes(selectedMetric)
    ? selectedMetric
    : 'requests';
  const monetary = metric !== 'requests' && metric !== 'tokens';
  const data = comparisonRows(
    rows,
    metric,
    t(($) => $.other),
  );
  const name =
    metric === 'requests'
      ? t(($) => $.requests)
      : metric === 'tokens'
        ? 'Token'
        : t(($) => $.estimatedCurrency, { currency: metric });
  return (
    <figure className="flex min-w-0 flex-col gap-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm font-medium">{title}</figcaption>
        <MetricSelector
          currencies={currencies}
          value={metric}
          onChange={setMetric}
          label={t(($) => $.comparisonMetric)}
        />
      </div>
      {data.length ? (
        <ChartContainer
          config={{ value: { label: name, color: 'var(--chart-1)' } }}
          className="w-full aspect-auto"
          style={{ height: `${data.length * 2.25 + 2}rem` }}
        >
          <BarChart
            data={data}
            layout="vertical"
            accessibilityLayer
            margin={{ right: 12, left: 0, top: 4, bottom: 0 }}
          >
            <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              allowDecimals={monetary}
              tickFormatter={(v) =>
                formatNumber(v, { notation: 'compact', maximumFractionDigits: 2 })
              }
            />
            <YAxis
              type="category"
              dataKey="label"
              width={112}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
            />
            <ChartTooltip
              isAnimationActive={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, payload) => payload[0]?.payload.label}
                  formatter={(_value, _name, entry) => (
                    <>
                      <span className="text-muted-foreground">{name}</span>
                      <span className="ml-auto font-mono tabular-nums">
                        {monetary
                          ? `${metric} ${formatAmount(entry.payload.amount)}${entry.payload.unpriced ? t(($) => $.partial) : ''}`
                          : metric === 'tokens'
                            ? `${formatNumber(Number(entry.payload.amount))} Tokens`
                            : t(($) => $.requestCount, { count: Number(entry.payload.amount) })}
                      </span>
                    </>
                  )}
                />
              }
            />
            <Bar
              name="value"
              dataKey="value"
              fill="var(--color-value)"
              radius={[0, 3, 3, 0]}
              maxBarSize={20}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      ) : (
        <p className="text-xs text-muted-foreground">{t(($) => $.empty)}</p>
      )}
    </figure>
  );
}
