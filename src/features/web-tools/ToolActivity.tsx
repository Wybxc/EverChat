import { Button } from '@/components/ui/button';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { ArrowUpRight, Globe, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problem } from '../../../shared/errors/descriptor';
import type { PublicToolCall } from '../../../shared/web-tools/tasks';
import { useDisclosureController, useDisclosureState } from '../../components/Disclosure';
import { issueMessage, renderUiMessage } from '../../platform/i18n/messages';
import { PAUSE_FOLLOW_EVENT } from '../chat/scroll-intent';
import './locales';

const labels = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;
const callId = (messageId: string, id: string) => `tool-${messageId}-${id}`;

function SourceContent({
  source,
  stateKey,
}: {
  source: { title: string; url: string; content: string };
  stateKey: string;
}) {
  const { t } = useTranslation('web-tools');
  const [open, setOpen] = useDisclosureState(stateKey);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        title={source.title}
      >
        <TraceLine>
          <TraceIcon>
            <Globe />
          </TraceIcon>
          <TraceTitle>
            {source.title}
            <span className="sr-only">{t(($) => $.newTab)}</span>
          </TraceTitle>
          <TraceIcon>
            <ArrowUpRight />
          </TraceIcon>
        </TraceLine>
      </a>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle>{t(($) => $.viewContent)}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{source.content}</p>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolCallView({ item, messageId }: { item: PublicToolCall; messageId: string }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });
  const { call, state, result, round } = item;
  const [open, setOpen] = useDisclosureState(`tools:${messageId}:${call.id}`);
  const id = callId(messageId, call.id);
  const input = call.name === 'web_search' ? call.input.query : call.input.url;
  const line = (
    <TraceLine
      status={
        state === 'running'
          ? 'running'
          : state === 'queued'
            ? 'pending'
            : state === 'failed'
              ? 'error'
              : undefined
      }
    >
      <TraceIcon>{call.name === 'web_search' ? <Search /> : <Globe />}</TraceIcon>
      <TraceTitle title={input}>
        {call.name === 'web_search' ? t(($) => $.search) : t(($) => $.fetch)} · {input}
        <span className="sr-only">{t(($) => $.round, { round: round + 1 })}</span>
      </TraceTitle>
      <TraceDescription>
        {t(($) => $[labels[state]])}
        {result?.status === 'completed'
          ? ` · ${t(($) => $.sourcesCount, { count: result.sources.length })}`
          : ''}
      </TraceDescription>
    </TraceLine>
  );
  return (
    <div
      id={id}
      tabIndex={-1}
      data-tool-id={call.id}
      data-tool-state={state}
      aria-describedby={result?.status === 'failed' ? `${id}-error` : undefined}
    >
      {result ? (
        <TraceCollapsible open={open} onOpenChange={setOpen} data-testid="tool-call">
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            {result.status === 'completed' ? (
              result.sources.length ? (
                <Trace>
                  {[...new Map(result.sources.map((source) => [source.url, source])).values()].map(
                    (source) => (
                      <SourceContent
                        key={source.url}
                        source={source}
                        stateKey={`tools:${messageId}:${call.id}:${source.url}`}
                      />
                    ),
                  )}
                </Trace>
              ) : (
                <p>{t(($) => $.noSources)}</p>
              )
            ) : (
              <p>{t(($) => $[labels[state]])}</p>
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        <div data-testid="tool-call">{line}</div>
      )}
    </div>
  );
}

export function ToolActivity({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
  return (
    <Trace data-testid="tool-activity" data-search-ignore>
      {calls.map((item) => (
        <ToolCallView key={item.call.id} item={item} messageId={messageId} />
      ))}
    </Trace>
  );
}

export function ToolFailures({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });
  const setOpen = useDisclosureController();
  const locate = (id: string) => {
    setOpen?.(`reasoning:${messageId}`, true);
    setOpen?.(`tools:${messageId}:${id}`, true);
    requestAnimationFrame(() => {
      const target = document.getElementById(callId(messageId, id));
      for (let element = target; element; element = element.parentElement) {
        if (
          element.classList.contains('reasoning-content') ||
          element.dataset.testid === 'message-viewport'
        )
          element.dispatchEvent(new Event(PAUSE_FOLLOW_EVENT));
      }
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
