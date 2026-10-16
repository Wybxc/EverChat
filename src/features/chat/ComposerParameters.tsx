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
  openWeb,
  estimate,
  focusComposer,
}: {
  compact: boolean;
  model?: ChatModel;
  effort: ReasoningEffort | '';
  chooseEffort: (effort: ReasoningEffort | '') => void;
  webEnabled: boolean;
  openWeb: () => void;
  estimate?: ContextEstimate;
  focusComposer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const nextAction = useRef<(() => void) | null>(null);
  useEffect(() => setOpen(false), [compact]);
  const effortLabel = effort ? effortLabels[effort] : '默认';
  const description = `思维：${effortLabel}；联网${webEnabled ? '已开启' : '未开启'}`;
  const reasoning = model?.reasoningSupported && model.reasoningEfforts.length > 0 && (
    <NativeSelect
      aria-label="思维强度"
      title={`思维强度：${effortLabel}`}
      className={compact ? 'w-full' : 'w-24 shrink-0'}
      selectClassName={compact ? 'text-sm' : 'border-transparent pl-1 pr-6 text-xs'}
      value={effort}
      onChange={(event) => chooseEffort(event.target.value as ReasoningEffort | '')}
    >
      <option value="">思考</option>
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
      size={compact ? 'default' : 'icon'}
      type="button"
      className={`${compact ? 'w-full justify-start' : 'composer-icon'} ${webEnabled ? 'bg-muted' : ''}`}
      aria-label="联网工具"
      aria-pressed={webEnabled}
      title={webEnabled ? '联网已开启' : '联网工具'}
      onClick={() => {
        if (compact) {
          // Open the dialog after the popover has returned focus to a persistent trigger.
          nextAction.current = openWeb;
          setOpen(false);
        } else openWeb();
      }}
    >
      <Globe className="size-[1.125rem]" />
      {compact && `联网${webEnabled ? '已开启' : '工具'}`}
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon"
          className={`composer-icon relative ${effort || webEnabled ? 'bg-muted' : ''}`}
          aria-label="更多参数"
          aria-description={description}
          title={description}
        >
          <SlidersHorizontal className="size-[1.125rem]" />
          {(effort || webEnabled) && (
            <span
              aria-hidden="true"
              className="absolute top-0 right-0 rounded bg-secondary px-0.5 text-[0.625rem] leading-tight text-secondary-foreground"
            >
              {effort ? effortLabels[effort].slice(0, 1) : '网'}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-label="更多参数"
        className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4"
        onCloseAutoFocus={(event) => {
          const action = nextAction.current;
          nextAction.current = null;
          if (action) {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
            action();
          } else if (!trigger.current?.isConnected) {
            event.preventDefault();
            focusComposer();
          }
        }}
      >
        {reasoning && (
          <label className="space-y-1 text-xs">
            <span>思维强度</span>
            {reasoning}
          </label>
        )}
        {web}
        {estimate && (
          <section data-testid="context-estimate" className="border-t pt-3 text-xs">
            <h2 className="mb-2 font-medium">上下文估算</h2>
            <ContextEstimateDetails estimate={estimate} />
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}
