import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Globe, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problem } from '../../../shared/errors/descriptor';
import type { PublicToolCall } from '../../../shared/web-tools/tasks';
import { Disclosure } from '../../components/Disclosure';
import { issueMessage, renderUiMessage } from '../../platform/i18n/messages';
import { PAUSE_FOLLOW_EVENT } from '../chat/useFollowScroll';
import './locales';

const labels = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;
const callId = (messageId: string, id: string) => `tool-${messageId}-${id}`;

export function ToolActivity({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });

  return (
    <div data-testid="tool-activity" data-search-ignore className="space-y-1 text-sm">
      {calls.map(({ call, state, result, round }) => {
        const id = callId(messageId, call.id);
        return (
          <div
            key={call.id}
            id={id}
            tabIndex={-1}
            data-tool-id={call.id}
            data-tool-state={state}
            aria-describedby={result?.status === 'failed' ? `${id}-error` : undefined}
          >
            <Disclosure
              stateKey={`tools:${messageId}:${call.id}`}
              testId="tool-call"
              title={
                <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 break-words">
                  {call.name === 'web_search' ? (
                    <Search aria-hidden="true" className="h-[0.875rem] w-[0.875rem] shrink-0" />
                  ) : (
                    <Globe aria-hidden="true" className="h-[0.875rem] w-[0.875rem] shrink-0" />
                  )}
                  <span>{call.name === 'web_search' ? t(($) => $.search) : t(($) => $.fetch)}</span>
                  <span className="min-w-0 font-normal break-all">
                    {call.name === 'web_search' ? call.input.query : call.input.url}
                  </span>
                  <Badge>{t(($) => $[labels[state]])}</Badge>
                  {state === 'running' && <Spinner aria-hidden="true" />}
                  {result?.status === 'completed' && (
                    <span className="text-xs font-normal">
                      {t(($) => $.sourcesCount, { count: result.sources.length })}
                    </span>
                  )}
                  <span className="sr-only">{t(($) => $.round, { round: round + 1 })}</span>
                </span>
              }
            >
              {result?.status === 'completed' ? (
                result.sources.length ? (
                  <ul className="space-y-1">
                    {result.sources.map((source, index) => (
                      <li key={`${source.url}:${index}`}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                          className="link break-words"
                        >
                          {source.title}
                        </a>
                        <Disclosure
                          stateKey={`tools:${messageId}:${call.id}:${index}`}
                          title={t(($) => $.viewContent)}
                        >
                          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                            {source.content}
                          </p>
                        </Disclosure>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t(($) => $.noSources)}</p>
                )
              ) : (
                <p>
                  {result?.status === 'failed'
                    ? renderUiMessage(issueMessage(result.issue ?? problem('TOOL_FAILED')))
                    : t(($) => $[labels[state]])}
                </p>
              )}
            </Disclosure>
          </div>
        );
      })}
    </div>
  );
}

export function ToolFailures({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });

  const locate = (id: string) => {
    const target = document.getElementById(callId(messageId, id));
    for (let element = target; element; element = element.parentElement) {
      if (element instanceof HTMLDetailsElement) element.open = true;
      if (element.classList.contains('reasoning-content'))
        element.dispatchEvent(new Event(PAUSE_FOLLOW_EVENT));
    }
    const call = target?.querySelector('details');
    if (call) call.open = true;
    requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  };
  return calls
    .filter((item) => item.result?.status === 'failed')
    .map((item) => (
      <div key={item.call.id} className="mb-1 flex items-start gap-2 text-xs">
        <p
          id={`${callId(messageId, item.call.id)}-error`}
          role="alert"
          className="min-w-0 flex-1 py-2"
        >
          <span className="font-medium">
            {t(($) => $.failureLabel, {
              round: item.round + 1,
              tool: item.call.name === 'web_search' ? t(($) => $.search) : t(($) => $.fetchLabel),
            })}
          </span>
          {item.result?.status === 'failed'
            ? renderUiMessage(issueMessage(item.result.issue ?? problem('TOOL_FAILED')))
            : ''}
        </p>
        <Button
          variant="ghost"
          type="button"
          className="shrink-0"
          onClick={() => locate(item.call.id)}
          aria-label={t(($) => $.failedCallLabel, {
            input: item.call.name === 'web_search' ? item.call.input.query : item.call.input.url,
          })}
        >
          {t(($) => $.viewCall)}
        </Button>
      </div>
    ));
}
