import { useTranslation } from 'react-i18next';
import './locales';
import { MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react';
import { messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import { type Message } from '../../../shared/conversation/types';
import { ActionMenu, ActionMenuItem, ActionMenuSeparator } from '../../components/ActionMenu';
import { Disclosure } from '../../components/Disclosure';
import { GenerationMetadata } from './GenerationMetadata';
import { MarkdownContent } from './rendering/MarkdownContent';
import { useFollowScroll } from './useFollowScroll';
import { ProviderFailureView } from '../providers/ProviderFailureView';

export function SummaryView({
  message,
  busy,
  onRetry,
  onDelete,
  onProviderSettings,
  selected,
}: {
  message: Message;
  busy: boolean;
  onRetry: () => void;
  onDelete: () => void;
  onProviderSettings: () => void;
  selected: boolean;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const scroll = useFollowScroll(message.id);
  if (message.deletedAt)
    return (
      <article
        data-testid="summary-message"
        data-message-id={message.id}
        className="text-xs text-muted-foreground"
      >
        {t(($) => $.summaryInvalid)}
      </article>
    );
  return (
    <article
      data-testid="summary-message"
      data-message-id={message.id}
      data-status={message.status}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-start gap-1">
        <Disclosure
          stateKey={`summary:${message.id}`}
          defaultOpen={isActive(message)}
          className="min-w-0 flex-1"
          title={
            <>
              {t(($) => $.summaryTitleCoverage, {
                title: message.summary!.automatic
                  ? t(($) => $.automaticSummary)
                  : t(($) => $.historySummary),
                count: message.summary!.sourceIds.length,
              })}
              {isActive(message)
                ? ` ${t(($) => $.summaryGenerating)}`
                : message.status === 'failed'
                  ? ` ${t(($) => $.summaryFailed)}`
                  : message.status === 'cancelled'
                    ? ` ${t(($) => $.summaryStopped)}`
                    : selected
                      ? ` ${t(($) => $.summaryUsed)}`
                      : ` ${t(($) => $.summaryUnused)}`}
            </>
          }
        >
          <div
            ref={scroll.viewportRef}
            className="max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain"
          >
            <div ref={scroll.contentRef}>
              {messageText(message) && (
                <MarkdownContent content={messageText(message)} streaming={isActive(message)} />
              )}
            </div>
          </div>
        </Disclosure>
        {!isActive(message) && message.generation && (
          <div className="order-3 w-full sm:order-none sm:w-auto">
            <GenerationMetadata generation={message.generation} messageId={message.id} />
          </div>
        )}
        <ActionMenu
          label={t(($) => $.moreSummaryActions)}
          icon={<MoreHorizontal className="h-[1.0625rem] w-[1.0625rem]" />}
          placement="dropdown-top dropdown-end"
        >
          <ActionMenuItem disabled={busy || !navigator.onLine} onSelect={onRetry}>
            <RefreshCw className="h-[0.9375rem] w-[0.9375rem]" />
            {t(($) => $.regenerateSummary)}
          </ActionMenuItem>
          <ActionMenuSeparator />
          <ActionMenuItem disabled={busy || !navigator.onLine} onSelect={onDelete}>
            <Trash2 className="h-[0.9375rem] w-[0.9375rem]" />
            {t(($) => $.deleteSummary)}
          </ActionMenuItem>
        </ActionMenu>
      </div>
      {message.error && (
        <ProviderFailureView
          summary={message.error}
          failure={message.generation?.failure}
          stateKey={`summary-failure:${message.id}`}
          onSettings={onProviderSettings}
        />
      )}
      {message.status === 'cancelled' && (
        <p className="text-sm">{t(($) => $.stoppedSummaryUnused)}</p>
      )}
    </article>
  );
}
