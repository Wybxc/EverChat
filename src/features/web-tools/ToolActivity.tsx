import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Globe, Search } from 'lucide-react';
import type { PublicToolCall } from '../../../shared/web-tools/tasks';
import { Disclosure } from '../../components/Disclosure';
import { PAUSE_FOLLOW_EVENT } from '../chat/useFollowScroll';

const labels = {
  queued: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};
const callId = (messageId: string, id: string) => `tool-${messageId}-${id}`;

export function ToolActivity({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
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
                  <span>{call.name === 'web_search' ? '搜索' : '读取网页'}</span>
                  <span className="min-w-0 font-normal break-all">
                    {call.name === 'web_search' ? call.input.query : call.input.url}
                  </span>
                  <Badge>{labels[state]}</Badge>
                  {state === 'running' && <Spinner aria-hidden="true" />}
                  {result?.status === 'completed' && (
                    <span className="text-xs font-normal">{result.sources.length} 个来源</span>
                  )}
                  <span className="sr-only">第 {round + 1} 轮</span>
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
                          title="查看内容"
                        >
                          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                            {source.content}
                          </p>
                        </Disclosure>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>没有找到来源。</p>
                )
              ) : (
                <p>{result?.status === 'failed' ? result.error : labels[state]}</p>
              )}
            </Disclosure>
          </div>
        );
      })}
    </div>
  );
}

export function ToolFailures({ calls, messageId }: { calls: PublicToolCall[]; messageId: string }) {
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
            第 {item.round + 1} 轮{item.call.name === 'web_search' ? '搜索' : '网页读取'}：
          </span>
          {item.result?.status === 'failed' ? item.result.error : ''}
        </p>
        <Button
          variant="ghost"
          type="button"
          className="shrink-0"
          onClick={() => locate(item.call.id)}
          aria-label={`查看失败调用 ${item.call.name === 'web_search' ? item.call.input.query : item.call.input.url}`}
        >
          查看调用
        </Button>
      </div>
    ));
}
