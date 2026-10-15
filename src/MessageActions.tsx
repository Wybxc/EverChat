import { Check, Copy, MoreHorizontal, Pencil, Quote, RefreshCw, Trash2 } from 'lucide-react';
import type { Message } from '../shared/types';
import { isActive } from '../shared/types';
import { ActionMenu } from './ActionMenu';
import { GenerationMetadata } from './GenerationMetadata';

export function MessageActions({ message, busy, copied, forking, canFork, canRetry, branchSelected, copy, quote, edit, remove, fork, retry, selectBranch }: {
  message: Message; busy: boolean; copied: boolean; forking: boolean; canFork: boolean; canRetry: boolean; branchSelected: boolean;
  copy: () => void; quote: () => void; edit: () => void; remove: () => void; fork: () => void; retry: () => void; selectBranch: () => void;
}) {
  const active = isActive(message), user = message.role === 'user';
  return <div className={`message-actions mt-2 flex flex-wrap items-center gap-1 text-base-content/80 ${user ? 'justify-end' : ''}`}>
    <button type="button" className="btn btn-ghost btn-sm gap-1.5" onClick={copy} aria-label="复制消息">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</button>
    {user ? <button type="button" className="btn btn-ghost btn-sm gap-1.5" onClick={quote} aria-label="引用消息"><Quote size={14} />引用</button>
      : <button type="button" className="btn btn-ghost btn-sm gap-1.5" disabled={active || busy || !canRetry} onClick={retry}><RefreshCw size={14} />重新生成</button>}
    <ActionMenu label="更多消息操作" icon={<MoreHorizontal size={17} />} className="btn btn-ghost btn-sm btn-square" placement="dropdown-top dropdown-end">
      {!user && <li><button type="button" onClick={quote} aria-label="引用消息"><Quote size={15} />引用</button></li>}
      <li><button type="button" disabled={!canFork || forking} onClick={fork} aria-label="复制到新对话">{forking ? <span className="loading loading-spinner loading-xs" /> : <Copy size={15} />}复制到新对话</button></li>
      {!user && message.status === 'completed' && !branchSelected && <li><button type="button" disabled={busy} onClick={selectBranch}>继续此分支</button></li>}
      <li><button type="button" disabled={active || busy || (!user && !navigator.onLine)} onClick={edit} aria-label={user ? '编辑为新版本' : '编辑回答'}><Pencil size={15} />{user ? '编辑为新版本' : '编辑回答'}</button></li>
      {!active && message.generation && <li><GenerationMetadata generation={message.generation} /></li>}
      <li><button type="button" disabled={active || busy || !navigator.onLine} onClick={remove} aria-label="删除消息"><Trash2 size={15} />删除消息</button></li>
    </ActionMenu>
    {!user && branchSelected && <span className="ml-1 text-xs text-base-content/70">当前分支</span>}
  </div>;
}
