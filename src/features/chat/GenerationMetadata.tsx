import { useTranslation } from 'react-i18next';
import './locales';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../platform/api';
import type { UsageTotals } from '../../../shared/usage/types';
import { formatAmount } from '../../../shared/usage/pricing';
import { useMemo, useState } from 'react';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatNumber } from '../../platform/i18n/format';

import { messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import type { Message } from '../../../shared/conversation/types';
import type { StreamUsage } from '../../../shared/streaming/provider-stream';
import { mergeGenerationDiagnostics } from '../../../shared/streaming/diagnostics';
import { countCharacters } from './character-count';
import { answerStages } from '../../../shared/conversation/continuation';

const usageFields = [
  ['inputTokens', 'inputTokensLabel'],
  ['cachedInputTokens', 'cacheReadLabel'],
  ['cacheWriteInputTokens', 'cacheWriteLabel'],
  ['uncachedInputTokens', 'uncachedLabel'],
  ['toolInputTokens', 'toolInputLabel'],
  ['outputTokens', 'outputTokensLabel'],
  ['textOutputTokens', 'textOutputLabel'],
  ['reasoningTokens', 'reasoningTokensLabel'],
  ['totalTokens', 'totalTokensLabel'],
] as const satisfies readonly [keyof StreamUsage, string][];
const timings = [
  ['firstTokenMs', 'firstTokenLabel'],
  ['queueMs', 'queueLabel'],
  ['durationMs', 'durationLabel'],
] as const;
const number = { format: formatNumber };
const compact = {
  format: (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 }),
};
const duration = (ms: number) =>
  ms < 1000 ? `${number.format(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

export function GenerationMetadata({
  message,
  providerNames,
}: {
  message: Message;
  providerNames?: Record<string, string>;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const { generation } = message;
  const text = messageText(message),
    reasoning = messageText(message, 'reasoning');
  const characters = useMemo(() => {
    const body = countCharacters(text),
      thought = countCharacters(reasoning);
    return { body, thought, total: body + thought };
  }, [text, reasoning]);
  const [open, setOpen] = useState(false);
  const cost = useQuery({
    queryKey: ['usage', 'answer', message.id, isActive(message)],
    enabled: open,
    queryFn: ({ signal }) =>
      api<UsageTotals>(`/usage/answers/${message.id}`, 'GET', undefined, signal),
    refetchOnWindowFocus: false,
  });
  const stages = message.continuation ? answerStages(message) : [];
  const combinedTokens =
    stages.length &&
    stages.every(
      (stage) => stage.generation?.usageIsFinal && stage.generation.usage.totalTokens !== undefined,
    )
      ? stages.reduce((sum, stage) => sum + stage.generation!.usage.totalTokens!, 0)
      : undefined;
  const combinedCost = useQuery({
    queryKey: ['usage', 'answer-composition', message.id, isActive(message)],
    enabled: open && Boolean(message.continuation),
    queryFn: ({ signal }) =>
      api<UsageTotals>(
        '/usage/answers',
        'POST',
        { messageIds: stages.map((stage) => stage.id) },
        signal,
      ),
    refetchOnWindowFocus: false,
  });
  if (!generation) return null;
  const fields = usageFields.filter(([key]) => generation.usage[key] !== undefined);
  const usage = generation.usage;
  const tokens =
    usage.totalTokens !== undefined
      ? `${compact.format(usage.totalTokens)} Tokens`
      : usage.outputTokens !== undefined
        ? t(($) => $.outputTokenSummary, { tokens: compact.format(usage.outputTokens) })
        : usage.inputTokens !== undefined
          ? t(($) => $.inputTokenSummary, { tokens: compact.format(usage.inputTokens) })
          : '';
  const diagnostics = mergeGenerationDiagnostics(
    generation.diagnostics,
    isActive(message) ? message.streamState?.diagnostics : undefined,
  );
  const elapsed = generation.timing?.durationMs;
  const summary = [
    message.continuation
      ? t(($) => $.continuationStages, { count: message.continuation.stages.length })
      : '',
    t(($) => $.characterSummary, {
      count: characters.body,
      characters: compact.format(characters.body),
    }),
    characters.thought
      ? t(($) => $.reasoningCharacterSummary, {
          count: characters.thought,
          characters: compact.format(characters.thought),
        })
      : '',
    tokens && !generation.usageIsFinal ? t(($) => $.partial) : '',
    tokens,
    diagnostics?.warnings.length ? t(($) => $.providerWarnings) : '',
    elapsed === undefined ? '' : `${(elapsed / 1000).toFixed(1)} s`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Button
        variant="ghost"
        type="button"
        className="min-w-0 max-w-full px-2 text-xs text-muted-foreground"
        aria-label={t(($) => $.generationInfo)}
        aria-description={summary || undefined}
        data-testid="generation-summary"
        title={summary || t(($) => $.generationInfo)}
        onClick={(event) => {
          // Safari does not focus a button on pointer activation; remember this dialog's trigger.
          event.currentTarget.focus({ preventScroll: true });
          setOpen(true);
        }}
      >
        <span className="truncate">{summary || t(($) => $.generationInfo)}</span>
      </Button>
      <Modal showCloseButton open={open} onOpenChange={setOpen}>
        <div data-testid="message-generation" className="w-full max-w-md space-y-4 p-5 text-xs">
          <ModalTitle>{t(($) => $.generationInfo)}</ModalTitle>
          {stages.length > 0 && (
            <section className="flex flex-col gap-3" data-testid="continuation-provenance">
              <h3 className="font-medium">
                {t(($) => $.continuationStages, { count: stages.length - 1 })}
              </h3>
              {stages.map((stage, index) => (
                <dl key={stage.id} className="flex flex-col gap-1">
                  <dt className="font-medium">
                    {index === 0
                      ? t(($) => $.originalAnswer)
                      : t(($) => $.continuationStage, { count: index })}{' '}
                    ·{' '}
                    {providerNames?.[stage.providerId ?? '']
                      ? `${providerNames[stage.providerId!]} · `
                      : ''}
                    {stage.modelName || stage.model || 'EverChat'}
                  </dt>
                  <dd>
                    {formatDateTime(stage.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
                  </dd>
                  {index > 0 && <dd>{t(($) => $.continuationInput)}</dd>}
                  <dd>
                    {t(($) => $.appendedCharacters, { count: countCharacters(messageText(stage)) })}
                    {stage.generation?.usage.totalTokens === undefined
                      ? ''
                      : ` · ${number.format(stage.generation.usage.totalTokens)} Tokens`}{' '}
                    ·{' '}
                    {stage.generation?.interrupted
                      ? t(($) =>
                          stage.generation?.interruptionReason === 'cancelled'
                            ? $.continuationStopped
                            : $.continuationInterrupted,
                        )
                      : stage.generation?.finishReason || stage.status}
                  </dd>
                </dl>
              ))}
              <p>
                {t(($) => $.combinedCost)}:{' '}
                {combinedCost.isPending
                  ? t(($) => $.loading)
                  : combinedCost.error
                    ? t(($) => $.unavailable)
                    : Object.entries(combinedCost.data?.currencies ?? {})
                        .map(([currency, amount]) => `${currency} ${formatAmount(amount)}`)
                        .join(' · ') || t(($) => $.unknown)}
              </p>
              <p>
                {t(($) => $.combinedTokens)}:{' '}
                {combinedTokens === undefined
                  ? t(($) => $.unknown)
                  : `${number.format(combinedTokens)} Tokens`}
              </p>
            </section>
          )}
          <div className="py-2">
            {message.continuation && (
              <h3 className="mb-2 font-medium">{t(($) => $.currentExecution)}</h3>
            )}
            <dl className="space-y-2">
              {(
                [
                  ['totalCharacters', 'totalCharactersLabel', characters.total],
                  ['bodyCharacters', 'bodyCharactersLabel', characters.body],
                  ['reasoningCharacters', 'reasoningCharactersLabel', characters.thought],
                ] as const
              ).map(([key, label, count]) => (
                <div key={key} className="flex items-baseline justify-between gap-4 sm:gap-6">
                  <dt title={t(($) => $.characterCountHint)}>{t(($) => $[label])}</dt>
                  <dd data-testid={`generation-${key}`}>{number.format(count)}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4">
                <dt>{t(($) => $.estimatedCost)}</dt>
                <dd>
                  {cost.isFetching
                    ? t(($) => $.loading)
                    : cost.error
                      ? t(($) => $.unavailable)
                      : Object.entries(cost.data?.currencies ?? {})
                          .map(([currency, amount]) => `${currency} ${formatAmount(amount)}`)
                          .join(' · ') || t(($) => $.unknown)}
                </dd>
              </div>
              {cost.data && (
                <div className="flex items-baseline justify-between gap-4">
                  <dt>{t(($) => $.actualRequests)}</dt>
                  <dd>
                    {t(($) => $.requestCosts, {
                      requests: cost.data.requests,
                      unpriced: cost.data.unpriced,
                    })}
                  </dd>
                </div>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event('everchat:open-usage'));
                }}
              >
                {t(($) => $.viewUsage)}
              </Button>
              <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                <dt>{t(($) => $.tokenUsage)}</dt>
                <dd>
                  {fields.length
                    ? generation.usageIsFinal
                      ? t(($) => $.providerReport)
                      : t(($) => $.partialReport)
                    : t(($) => $.noProviderUsage)}
                </dd>
              </div>
              {fields.map(([key, label]) => (
                <div key={key} className="flex items-baseline justify-between gap-4 sm:gap-6">
                  <dt>{t(($) => $[label])}</dt>
                  <dd data-testid={`generation-${key}`}>{number.format(generation.usage[key]!)}</dd>
                </div>
              ))}
              {timings
                .filter(([key]) => generation.timing?.[key] !== undefined)
                .map(([key, label]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>{t(($) => $[label])}</dt>
                    <dd data-testid={`generation-${key}`}>{duration(generation.timing![key]!)}</dd>
                  </div>
                ))}
              {diagnostics?.response &&
                (
                  [
                    ['actualModel', diagnostics.response.model],
                    ['responseId', diagnostics.response.id],
                    ['requestId', diagnostics.response.requestId],
                    [
                      'responseTime',
                      diagnostics.response.timestamp === undefined
                        ? undefined
                        : formatDateTime(diagnostics.response.timestamp, {
                            dateStyle: 'medium',
                            timeStyle: 'medium',
                          }),
                    ],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-4">
                      <dt>{t(($) => $[label])}</dt>
                      <dd
                        className="min-w-0 break-all text-right"
                        data-testid={`generation-${label}`}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
              {Boolean(diagnostics?.warnings.length) && (
                <div className="space-y-1" data-testid="generation-warnings">
                  <dt>{t(($) => $.providerWarnings)}</dt>
                  <dd>
                    <ul className="list-disc space-y-1 pl-4 break-words">
                      {diagnostics!.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {generation.context && (
                <>
                  <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>{t(($) => $.sentContextEstimate)}</dt>
                    <dd data-testid="generation-contextTokens">
                      ≈{number.format(generation.context.totalTokens)} /{' '}
                      {number.format(generation.context.inputBudget)}
                    </dd>
                  </div>
                  {generation.context.toolTokens !== undefined && (
                    <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                      <dt>{t(($) => $.toolsEstimate)}</dt>
                      <dd data-testid="generation-toolTokens">
                        ≈{number.format(generation.context.toolTokens)}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>{t(($) => $.historyMessages)}</dt>
                    <dd data-testid="generation-contextMessages">
                      {t(($) => $.historyRetained, {
                        retained: generation.context.retainedMessages,
                        omitted: generation.context.omittedMessages,
                      })}
                    </dd>
                  </div>
                  {generation.context.summaryTokens !== undefined && (
                    <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                      <dt>{t(($) => $.summaryEstimate)}</dt>
                      <dd data-testid="generation-summaryTokens">
                        ≈
                        {t(($) => $.summaryCoverage, {
                          tokens: number.format(generation.context.summaryTokens),
                          count: generation.context.summarizedMessages ?? 0,
                        })}
                      </dd>
                    </div>
                  )}
                </>
              )}
            </dl>
          </div>
        </div>
      </Modal>
    </>
  );
}
