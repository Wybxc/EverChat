import { useTranslation } from 'react-i18next';
import './locales';
import { useEffect, useRef, useState } from 'react';
import { Globe, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ContextEstimate } from '../../../shared/conversation/context-budget';
import type { ChatModel, ReasoningEffort } from '../../../shared/models/types';
import { effortLabels } from '../../../shared/models/selection';
import { ContextEstimateDetails, ContextEstimateView } from './ContextEstimate';

export function ComposerParameters({
  compact,
  model,
  effort,
  chooseEffort,
  webEnabled,
  toggleWeb,
  estimate,
  focusComposer,
}: {
  compact: boolean;
  model?: ChatModel;
  effort: ReasoningEffort | '';
  chooseEffort: (effort: ReasoningEffort | '') => void;
  webEnabled: boolean;
  toggleWeb: () => void;
  estimate?: ContextEstimate;
  focusComposer: () => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [compact]);
  const effortLabel = effort ? effortLabels[effort] : t(($) => $.default);
  const description = t(($) => $.reasoningDescription, { effort: effortLabel });
  const reasoning = model?.reasoningSupported && model.reasoningEfforts.length > 0 && (
    <NativeSelect
      aria-label={t(($) => $.reasoningEffort)}
      title={t(($) => $.reasoningEffortDescription, { effort: effortLabel })}
      className={compact ? 'w-full' : 'w-24 shrink-0'}
      selectClassName={compact ? 'text-sm' : 'border-transparent pl-1 pr-6 text-xs'}
      value={effort}
      onChange={(event) => chooseEffort(event.target.value as ReasoningEffort | '')}
    >
      <option value="">{t(($) => $.reasoning)}</option>
      {model.reasoningEfforts.map((value) => (
        <option key={value} value={value}>
          {effortLabels[value]}
        </option>
      ))}
    </NativeSelect>
  );
  const web = (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      className={`composer-icon ${webEnabled ? 'bg-accent text-accent-foreground' : ''}`}
      aria-label={t(($) => $.webSearch)}
      aria-pressed={webEnabled}
      title={webEnabled ? t(($) => $.disableWebSearch) : t(($) => $.enableWebSearch)}
      onClick={toggleWeb}
    >
      <Globe className="size-[1.125rem]" />
    </Button>
  );
  if (!compact)
    return (
      <>
        {reasoning}
        {web}
        {estimate && <ContextEstimateView estimate={estimate} />}
      </>
    );
  return (
    <>
      {web}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="icon"
            className={`composer-icon relative ${effort ? 'bg-muted' : ''}`}
            aria-label={t(($) => $.moreParameters)}
            aria-description={description}
            title={description}
          >
            <SlidersHorizontal className="size-[1.125rem]" />
            {effort && (
              <span
                aria-hidden="true"
                className="absolute top-0 right-0 rounded bg-secondary px-0.5 text-[0.625rem] leading-tight text-secondary-foreground"
              >
                {effortLabels[effort].slice(0, 1)}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          aria-label={t(($) => $.moreParameters)}
          className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4"
          onCloseAutoFocus={(event) => {
            if (!trigger.current?.isConnected) {
              event.preventDefault();
              focusComposer();
            }
          }}
        >
          {reasoning && (
            <label className="space-y-1 text-xs">
              <span>{t(($) => $.reasoningEffort)}</span>
              {reasoning}
            </label>
          )}
          {estimate && (
            <section data-testid="context-estimate" className="border-t pt-3 text-xs">
              <h2 className="mb-2 font-medium">{t(($) => $.contextEstimate)}</h2>
              <ContextEstimateDetails estimate={estimate} />
            </section>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
