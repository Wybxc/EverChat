import { useState } from 'react';
import { Globe, Search } from 'lucide-react';
import type { PublicToolTask } from '../shared/web-tools';

const labels = { queued: '等待中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止' };
export function ToolActivity({ task }: { task?: PublicToolTask }) {
  const [open, setOpen] = useState(false);
  if (!task) return null;
  const status = task.status === 'active' ? task.calls.some((item) => item.state === 'running') ? '执行中' : '等待模型'
    : task.status === 'completed' ? '已完成' : task.status === 'cancelled' ? '已停止' : '未完成';
  return <div className="mb-4 text-sm"><details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="collapse collapse-arrow bg-base-200" data-testid="tool-activity">
    <summary className="collapse-title min-h-0 py-3 font-medium">联网工具 <span className="ml-2 text-xs font-normal" role="status">{status}</span></summary>
    <div className="collapse-content">
      <ol className="space-y-4">
        {task.calls.map(({ call, state, result, round }) => <li key={call.id} data-tool-id={call.id} data-tool-state={state} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {call.name === 'web_search' ? <Search size={14} aria-hidden="true" /> : <Globe size={14} aria-hidden="true" />}
            <span>{call.name === 'web_search' ? '搜索' : '读取网页'}</span><span className="badge badge-outline badge-sm">{labels[state]}</span>
            {state === 'running' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            <span className="sr-only">第 {round + 1} 轮</span>
          </div>
          <p className="break-words">{call.name === 'web_search' ? call.input.query : call.input.url}</p>
          {result?.status === 'failed' && <p role="alert" className="font-medium">{result.error}</p>}
          {result?.status === 'completed' && (result.sources.length ? <ul className="space-y-2">
            {result.sources.map((source, index) => <li key={`${source.url}:${index}`}>
              <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="link break-words">{source.title}</a>
              <details className="mt-1"><summary className="cursor-pointer">查看内容</summary><p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{source.content}</p></details>
            </li>)}
          </ul> : <p>没有找到来源。</p>)}
        </li>)}
      </ol>
    </div>
  </details>
    {task.calls.filter((item) => item.result?.status === 'failed').map((item) => <p key={item.call.id} role="alert" className="mt-2 px-3 text-xs">{item.result?.status === 'failed' ? item.result.error : ''}</p>)}
  </div>;
}
