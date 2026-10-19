import { formatNumber, formatDateTime } from '../../platform/i18n/format';
import { useTranslation } from 'react-i18next';
import './locales';
import { useState } from 'react';
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { NativeSelect } from '@/components/ui/native-select';
import type { UsageGroup } from '../../../shared/usage/types';
import { formatAmount } from '../../../shared/usage/pricing';

export function UsageChart({ points }: { points: UsageGroup[] }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  const [selectedMetric, setMetric] = useState('requests');
  const currencies = [...new Set(points.flatMap((point) => Object.keys(point.currencies)))];
  const metric = ['requests', 'tokens', ...currencies].includes(selectedMetric)
    ? selectedMetric
    : 'requests';
  const name =
    metric === 'requests'
      ? t(($) => $.requests)
      : metric === 'tokens'
        ? 'Token'
        : t(($) => $.estimatedCurrency, { currency: metric });
  const data = points.map((point) => ({
    ...point,
    value:
      metric === 'requests'
        ? point.requests
        : metric === 'tokens'
          ? point.inputTokens + point.outputTokens
          : Number(point.currencies[metric] ?? '0') / 1e12,
  }));
  const tick = (value: string) => value.replace(/^\d{4}-/, '');
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
    <figure className="min-w-0 space-y-2" aria-label={t(($) => $.chart)}>
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm font-medium">{t(($) => $.trend)}</figcaption>
        <NativeSelect
          aria-label={t(($) => $.trendMetric)}
          value={metric}
          onChange={(event) => setMetric(event.target.value)}
        >
          <option value="requests">{t(($) => $.requests)}</option>
          <option value="tokens">Token</option>
          {currencies.map((currency) => (
            <option key={currency} value={currency}>
              {t(($) => $.estimatedCurrency, { currency })}
            </option>
          ))}
        </NativeSelect>
      </div>
      {points.length ? (
        <div className="usage-chart h-60 min-w-0 text-xs text-muted-foreground">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
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
                tickFormatter={(at) => date(at)}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
                stroke="currentColor"
              />
              <YAxis
                width={48}
                tickFormatter={(value: number) =>
                  formatNumber(
                    value,
                    metric === 'requests' || metric === 'tokens'
                      ? { notation: 'compact', maximumFractionDigits: 2 }
                      : { maximumSignificantDigits: 3 },
                  )
                }
                allowDecimals={metric !== 'requests' && metric !== 'tokens'}
                tickLine={false}
                axisLine={false}
                stroke="currentColor"
              />
              <Tooltip
                labelFormatter={(_label, payload) =>
                  payload[0]?.payload.at === undefined ? '' : date(payload[0].payload.at)
                }
                formatter={(value, _name, entry) => [
                  metric === 'requests'
                    ? t(($) => $.requestCount, { count: Number(value) })
                    : metric === 'tokens'
                      ? `${formatNumber(Number(value))} Tokens`
                      : `${metric} ${formatAmount(entry.payload.currencies[metric] ?? '0')}`,
                  name,
                ]}
                contentStyle={{
                  background: 'var(--popover)',
                  color: 'var(--popover-foreground)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontSize: '0.75rem',
                }}
                cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
                isAnimationActive={false}
              />
              <Line
                name={name}
                type="linear"
                dataKey="value"
                stroke="var(--ring)"
                strokeWidth={2}
                dot={points.length < 32 ? { r: 3, fill: 'var(--background)' } : false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
              {points.length > 7 && (
                <Brush
                  dataKey="label"
                  height={28}
                  travellerWidth={10}
                  tickFormatter={tick}
                  stroke="var(--ring)"
                  fill="var(--muted)"
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t(($) => $.empty)}</p>
      )}
    </figure>
  );
}
