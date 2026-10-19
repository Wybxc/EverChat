import { useState } from 'react';
import { NativeSelect } from '@/components/ui/native-select';
import type { UsageGroup } from '../../../shared/usage/types';
import { formatAmount } from '../../../shared/usage/pricing';

export function UsageChart({ points }: { points: UsageGroup[] }) {
  const [metric, setMetric] = useState('requests'),
    [active, setActive] = useState<string | null>(null);
  const currencies = [...new Set(points.flatMap((p) => Object.keys(p.currencies)))];
  const value = (point: UsageGroup) =>
    metric === 'requests'
      ? point.requests
      : metric === 'tokens'
        ? point.inputTokens + point.outputTokens
        : Number(point.currencies[metric] ?? '0') / 1e12;
  const label = (point: UsageGroup) =>
    metric === 'requests'
      ? `${point.requests} 次请求`
      : metric === 'tokens'
        ? `${value(point)} Tokens`
        : `${metric} ${formatAmount(point.currencies[metric] ?? '0')}`;
  const max = Math.max(1e-12, ...points.map(value)),
    current = points.find((p) => p.key === active);
  const first = points[0]?.at ?? 0,
    last = points.at(-1)?.at ?? first;
  const step = points.some((p) => p.key.includes('GMT')) ? 3_600_000 : 86_400_000;
  const span = Math.max(step, last - first + step);
  return (
    <figure className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm font-medium">趋势</figcaption>
        <NativeSelect
          aria-label="趋势指标"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
        >
          <option value="requests">请求量</option>
          <option value="tokens">Token</option>
          {currencies.map((c) => (
            <option key={c} value={c}>
              估算费用（{c}）
            </option>
          ))}
        </NativeSelect>
      </div>
      {points.length ? (
        <>
          <div className="relative h-28" aria-label="用量趋势图">
            {points.map((point) => (
              <button
                key={point.key}
                type="button"
                aria-label={`${point.label}，${label(point)}`}
                title={`${point.label} · ${label(point)}`}
                onFocus={() => setActive(point.key)}
                onClick={() => setActive(point.key)}
                className="absolute bottom-0 min-w-px rounded-t bg-primary/70 hover:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                style={{
                  left: `${(100 * ((point.at ?? first) - first)) / span}%`,
                  width: `max(1px, calc(${(100 * step) / span}% - 2px))`,
                  height: `${Math.max(2, (value(point) / max) * 100)}%`,
                }}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{points[0]?.label}</span>
            <span>{points.at(-1)?.label}</span>
          </div>
          {current && (
            <p className="text-xs" role="status">
              {current.label} · {label(current)}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">暂无数据</p>
      )}
    </figure>
  );
}
