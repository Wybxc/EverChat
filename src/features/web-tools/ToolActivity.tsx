import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Globe, Search } from 'lucide-react';
import { useId } from 'react';
import type { PublicToolTask } from '../../../shared/web-tools/tasks';
import { Disclosure } from '../../components/Disclosure';

const labels = {
  queued: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};
export function ToolActivity({ task, stateKey }: { task?: PublicToolTask; stateKey?: string }) {
  const prefix = useId();
  const callId = (id: string) => `${prefix}-call-${id}`;
  const locate = (id: string) => {
    const target = document.getElementById(callId(id));
    const disclosure = target?.closest('details');
    if (disclosure) disclosure.open = true;
    requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  };
  if (!task) return null;
  const status =
    task.status === 'active'
      ? task.calls.some((item) => item.state === 'running')
        ? '执行中'
        : '等待模型'
      : task.status === 'completed'
        ? '已完成'
        : task.status === 'cancelled'
          ? '已停止'
          : '未完成';
  return (
    <div className="mb-2 text-sm">
      <Disclosure
        stateKey={stateKey}
        testId="tool-activity"
        title={
          <>
            联网工具{' '}
            <span className="ml-2 text-xs font-normal" role="status">
              {task.calls.length} 次调用 · {status}
            </span>
          </>
        }
      >
        <ol className="space-y-3">
          {task.calls.map(({ call, state, result, round }) => (
            <li
              key={call.id}
              id={callId(call.id)}
              tabIndex={-1}
              aria-describedby={
                result?.status === 'failed' ? `${callId(call.id)}-error` : undefined
              }
              data-tool-id={call.id}
              data-tool-state={state}
              className="space-y-1"
            >
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {call.name === 'web_search' ? (
                  <Search aria-hidden="true" className="h-[0.875rem] w-[0.875rem]" />
                ) : (
                  <Globe aria-hidden="true" className="h-[0.875rem] w-[0.875rem]" />
                )}
                <span>{call.name === 'web_search' ? '搜索' : '读取网页'}</span>
                <Badge>{labels[state]}</Badge>
                {state === 'running' && <Spinner aria-hidden="true" />}
                <span className="sr-only">第 {round + 1} 轮</span>
              </div>
              <p className="break-words">
                {call.name === 'web_search' ? call.input.query : call.input.url}
              </p>
              {result?.status === 'completed' &&
                (result.sources.length ? (
                  <ul className="space-y-2">
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
                          stateKey={stateKey ? `${stateKey}:${call.id}:${index}` : undefined}
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
                ))}
            </li>
          ))}
        </ol>
      </Disclosure>
      {task.calls
        .filter((item) => item.result?.status === 'failed')
        .map((item) => (
          <div key={item.call.id} className="mt-1 flex items-start gap-2 text-xs">
            <p id={`${callId(item.call.id)}-error`} role="alert" className="min-w-0 flex-1 py-2">
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
        ))}
    </div>
  );
}
