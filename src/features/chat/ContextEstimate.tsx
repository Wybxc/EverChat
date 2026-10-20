import { useTranslation } from 'react-i18next';
import './locales';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { ContextEstimate } from '../../../shared/conversation/context-budget';
import { metadataSourceLabel } from '../providers/model-labels';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatNumber } from '../../platform/i18n/format';

const number = { format: formatNumber };
const compact = {
  format: (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 }),
};

export function ContextEstimateView({ estimate }: { estimate: ContextEstimate }) {
  const { t } = useTranslation('chat', { useSuspense: false });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          data-testid="context-estimate"
          className="context-trigger relative min-w-11 shrink-0 px-2 text-xs text-muted-foreground"
          aria-label={t(($) => $.viewContextEstimate)}
          aria-description={t(($) => $.contextDescription, {
            total: number.format(estimate.totalTokens),
            budget: number.format(estimate.inputBudget),
          })}
        >
          <span>≈{compact.format(estimate.totalTokens)}</span>
          {estimate.windowSource !== 'fallback' && estimate.inputBudget > 0 && (
            <Progress
              aria-hidden
              className="absolute bottom-1 left-1/2 w-10 -translate-x-1/2"
              value={Math.min(100, (100 * estimate.totalTokens) / estimate.inputBudget)}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t(($) => $.contextEstimate)}
        side="top"
        align="end"
        className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4 text-xs"
      >
        <ContextEstimateDetails estimate={estimate} />
      </PopoverContent>
    </Popover>
  );
}

export function ContextEstimateDetails({ estimate }: { estimate: ContextEstimate }) {
  const { t } = useTranslation('chat', { useSuspense: false });

  return (
    <>
      {estimate.windowSource !== 'fallback' && estimate.inputBudget > 0 && (
        <Progress
          className="mb-2"
          aria-label={t(($) => $.contextEstimate)}
          aria-valuetext={t(($) => $.contextDescription, {
            total: number.format(estimate.totalTokens),
            budget: number.format(estimate.inputBudget),
          })}
          value={Math.min(100, (100 * estimate.totalTokens) / estimate.inputBudget)}
        />
      )}
      <p>
        {t(($) => $.contextTokens, {
          total: number.format(estimate.totalTokens),
          budget: number.format(estimate.inputBudget),
        })}
      </p>
      <p>
        {t(($) => $.inputTokens, { tokens: number.format(estimate.inputTokens) })}
        {estimate.windowSource === 'fallback' ? t(($) => $.windowUnknown) : ''}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <dt>{t(($) => $.systemEstimate)}</dt>
        <dd>{number.format(estimate.systemTokens)}</dd>
        <dt>{t(($) => $.historyEstimate)}</dt>
        <dd>
          {t(($) => $.historyTokens, {
            tokens: number.format(estimate.historyTokens),
            count: estimate.retainedMessages,
          })}
        </dd>
        {estimate.imageTokens !== undefined && (
          <>
            <dt>{t(($) => $.imageAllocation)}</dt>
            <dd>{number.format(estimate.imageTokens)}</dd>
          </>
        )}
        {estimate.summaryTokens !== undefined && (
          <>
            <dt>{t(($) => $.summaryEstimate)}</dt>
            <dd>
              {t(($) => $.summaryCoverage, {
                tokens: number.format(estimate.summaryTokens),
                count: estimate.summarizedMessages ?? 0,
              })}
            </dd>
          </>
        )}
        {estimate.documentTokens !== undefined && (
          <>
            <dt>{t(($) => $.fileEstimate)}</dt>
            <dd>{number.format(estimate.documentTokens)}</dd>
          </>
        )}
        <dt>{t(($) => $.modelWindow)}</dt>
        <dd>
          {number.format(estimate.contextWindow)} · {metadataSourceLabel(estimate.windowSource)}
        </dd>
        <dt>{t(($) => $.outputReserve)}</dt>
        <dd>
          {number.format(estimate.outputReserve)}
          {estimate.contextScope === 'input' ? t(($) => $.separateWindow) : ''}
        </dd>
        <dt>{t(($) => $.safetyMargin)}</dt>
        <dd>{number.format(estimate.safetyMargin)}</dd>
      </dl>
      <p className="mt-2">{t(($) => $.estimateHint)}</p>
    </>
  );
}

export function ContextEstimateNotices({
  estimate,
  compressing = false,
}: {
  estimate: ContextEstimate;
  compressing?: boolean;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  return (
    <div className="text-xs text-muted-foreground">
      {compressing ? (
        <p className="mt-1" data-testid="automatic-compression-preview">
          {t(($) => $.autoCompactionNotice)}
        </p>
      ) : (
        estimate.omittedMessages > 0 && (
          <p className="mt-1" data-testid="context-omission">
            {t(($) => $.omittedHistory, { count: estimate.omittedMessages })}
          </p>
        )
      )}
      {!compressing && estimate.totalTokens > estimate.inputBudget && (
        <p className="mt-1" data-testid="context-budget-warning">
          {estimate.summaryTokens ? t(($) => $.summaryOverBudget) : t(($) => $.inputOverBudget)}
        </p>
      )}
    </div>
  );
}
