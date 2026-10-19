import { formatDateTime } from '../../platform/i18n/format';
import { useTranslation } from 'react-i18next';
import './locales';
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
  ['input', 'rateInput'],
  ['output', 'rateOutput'],
  ['reasoning', 'rateReasoning'],
  ['cacheRead', 'rateCacheRead'],
  ['cacheWrite', 'rateCacheWrite'],
  ['perRequest', 'ratePerRequest'],
] as const;
export const priceQuery = () => api<UsagePrice[]>('/usage/prices');

export function ModelPriceButton({ providerId, model }: { providerId: string; model: string }) {
  const { t } = useTranslation('usage', { useSuspense: false });

  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['usage', 'prices'], queryFn: priceQuery, enabled: open });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t(($) => $.configurePrice)}
      </Button>
      <Modal showCloseButton open={open} onOpenChange={setOpen}>
        <div className="flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-lg flex-col overflow-hidden p-4">
          <ModalTitle className="shrink-0 pr-8">{t(($) => $.pricingTitle)}</ModalTitle>
          <div className="min-h-0 overflow-y-auto pt-3">
            {query.isPending ? (
              <p role="status">{t(($) => $.loading)}</p>
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
  const { t } = useTranslation('usage', { useSuspense: false });

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
          setError(t(($) => $.invalidPrice));
          return;
        }
        setBusy(true);
        try {
          await api('/usage/prices', 'PUT', result.output);
          await client.invalidateQueries({ queryKey: ['usage'] });
          setNotice(t(($) => $.priceSaved));
          onSaved?.();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : t(($) => $.saveFailed));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="break-all text-sm">{model}</p>
      {copies.length > 0 && (
        <NativeSelect
          aria-label={t(($) => $.copyPrice)}
          value=""
          onChange={(event) => {
            const source = copies.find((p) => p.id === event.target.value);
            if (source) {
              const { id: _, effectiveFrom: __, ...value } = source;
              setDraft({ ...value, providerId, model });
            }
          }}
        >
          <option value="">{t(($) => $.copyPricePlaceholder)}</option>
          {copies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.model}
            </option>
          ))}
        </NativeSelect>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs">
          {t(($) => $.currency)}
          <Input
            aria-label={t(($) => $.pricingCurrency)}
            value={draft.currency}
            maxLength={3}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
          />
        </label>
        {rates.map(([key, labelKey]) => (
          <label key={key} className="space-y-1 text-xs">
            {t(($) => $[labelKey])}
            <Input
              aria-label={t(($) => $[labelKey])}
              inputMode="decimal"
              placeholder={t(($) => $.unknown)}
              value={draft[key] ?? ''}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value || null })}
            />
          </label>
        ))}
      </div>
      <label className="block space-y-1 text-xs">
        {t(($) => $.priceSource)}
        <Input
          aria-label={t(($) => $.priceSource)}
          maxLength={500}
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t(($) => $.priceHint)}</p>
      {saved?.id.startsWith('models.dev:') ? (
        <p className="text-xs text-muted-foreground">
          {t(($) => $.defaultPrice, { source: saved.source })}
        </p>
      ) : (
        saved && (
          <p className="text-xs text-muted-foreground">
            {t(($) => $.priceEffective, {
              date: formatDateTime(saved.effectiveFrom, {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
            })}
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
        {busy ? t(($) => $.saving) : t(($) => $.savePrice)}
      </Button>
    </form>
  );
}
