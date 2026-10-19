import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import {
  priceInputSchema,
  type UsagePrice,
  type UsagePriceInput,
} from '../../../shared/usage/types';

const rates = [
  ['input', '每百万输入 Token'],
  ['output', '每百万输出 Token'],
  ['reasoning', '每百万思考 Token'],
  ['cacheRead', '每百万缓存读取 Token'],
  ['cacheWrite', '每百万缓存写入 Token'],
  ['perRequest', '每次请求'],
] as const;
export const priceQuery = () => api<UsagePrice[]>('/usage/prices');

export function ModelPriceButton({ providerId, model }: { providerId: string; model: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['usage', 'prices'], queryFn: priceQuery, enabled: open });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        配置价格
      </Button>
      <Modal showCloseButton open={open} onOpenChange={setOpen}>
        <div className="flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-lg flex-col overflow-hidden p-4">
          <ModalTitle className="shrink-0 pr-8">模型定价</ModalTitle>
          <div className="min-h-0 overflow-y-auto pt-3">
            {query.isPending ? (
              <p role="status">读取中…</p>
            ) : query.error ? (
              <p role="alert">{query.error.message}</p>
            ) : (
              <PriceEditor
                key={`${providerId}:${model}`}
                providerId={providerId}
                model={model}
                prices={query.data ?? []}
                onSaved={() => setOpen(false)}
              />
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

export function PriceEditor({
  providerId,
  model,
  prices,
  onSaved,
}: {
  providerId: string;
  model: string;
  prices: UsagePrice[];
  onSaved?: () => void;
}) {
  const saved = prices.find((p) => p.providerId === providerId && p.model === model);
  const [draft, setDraft] = useState<UsagePriceInput>(() => ({
    providerId,
    model,
    currency: saved?.currency ?? 'CNY',
    input: saved?.input ?? null,
    output: saved?.output ?? null,
    reasoning: saved?.reasoning ?? null,
    cacheRead: saved?.cacheRead ?? null,
    cacheWrite: saved?.cacheWrite ?? null,
    perRequest: saved?.perRequest ?? null,
    source: saved?.source ?? '',
  }));
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const client = useQueryClient();
  const copies = prices.filter((p) => p.providerId === providerId && p.model !== model);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        setNotice('');
        const result = v.safeParse(priceInputSchema, draft);
        if (!result.success) {
          setError('币种须为三位大写代码；单价须为非负数，最多六位小数。');
          return;
        }
        setBusy(true);
        try {
          await api('/usage/prices', 'PUT', result.output);
          await client.invalidateQueries({ queryKey: ['usage'] });
          setNotice('已保存，仅影响后续请求。');
          onSaved?.();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : '保存失败。');
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="break-all text-sm">{model}</p>
      {copies.length > 0 && (
        <NativeSelect
          aria-label="复制其他模型价格"
          value=""
          onChange={(event) => {
            const source = copies.find((p) => p.id === event.target.value);
            if (source) {
              const { id: _, effectiveFrom: __, ...value } = source;
              setDraft({ ...value, providerId, model });
            }
          }}
        >
          <option value="">复制其他模型价格…</option>
          {copies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.model}
            </option>
          ))}
        </NativeSelect>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs">
          币种
          <Input
            aria-label="计价币种"
            value={draft.currency}
            maxLength={3}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
          />
        </label>
        {rates.map(([key, label]) => (
          <label key={key} className="space-y-1 text-xs">
            {label}
            <Input
              aria-label={label}
              inputMode="decimal"
              placeholder="未知"
              value={draft[key] ?? ''}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value || null })}
            />
          </label>
        ))}
      </div>
      <label className="block space-y-1 text-xs">
        价格来源
        <Input
          aria-label="价格来源"
          maxLength={500}
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        留空表示未知，0
        表示免费。缓存单价留空时继承输入单价，思考单价留空时继承输出单价。阶梯、套餐等复杂计费请在请求详情中修正。
      </p>
      {saved?.id.startsWith('models.dev:') ? (
        <p className="text-xs text-muted-foreground">
          默认参考价格：{saved.source} · USD。保存后使用自定义价格。
        </p>
      ) : (
        saved && (
          <p className="text-xs text-muted-foreground">
            当前价格生效于 {new Date(saved.effectiveFrom).toLocaleString()}
          </p>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? '保存中…' : '保存价格'}
      </Button>
    </form>
  );
}
