import { IconButton } from './IconButton';
import { ActionMenuItem } from './ActionMenu';
import { Spinner } from '@/components/ui/spinner';
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
  return <div className={`message-actions mt-1 flex flex-wrap items-center gap-1 text-muted-foreground ${user ? 'justify-end' : ''}`}>
    <IconButton type="button" onClick={copy} label="复制消息">{copied ? <Check className="h-[0.875rem] w-[0.875rem]" /> : <Copy className="h-[0.875rem] w-[0.875rem]" />}</IconButton>
    {user ? <IconButton type="button" onClick={quote} label="引用消息"><Quote className="h-[0.875rem] w-[0.875rem]" /></IconButton>
      : <IconButton type="button" label="重新生成" disabled={active || busy || !canRetry} onClick={retry}><RefreshCw className="h-[0.875rem] w-[0.875rem]" /></IconButton>}
    <ActionMenu label="更多消息操作" icon={<MoreHorizontal className="h-[1.0625rem] w-[1.0625rem]" />} placement="dropdown-top dropdown-end">
      {!user && <ActionMenuItem onSelect={quote} aria-label="引用消息"><Quote className="h-[0.9375rem] w-[0.9375rem]" />引用</ActionMenuItem>}
      <ActionMenuItem disabled={!canFork || forking} onSelect={fork} aria-label="复制到新对话">{forking ? <Spinner /> : <Copy className="h-[0.9375rem] w-[0.9375rem]" />}复制到新对话</ActionMenuItem>
      {!user && message.status === 'completed' && !branchSelected && <ActionMenuItem disabled={busy} onSelect={selectBranch}>继续此分支</ActionMenuItem>}
      <ActionMenuItem disabled={active || busy || (!user && !navigator.onLine)} onSelect={edit} aria-label={user ? '编辑为新版本' : '编辑回答'}><Pencil className="h-[0.9375rem] w-[0.9375rem]" />{user ? '编辑为新版本' : '编辑回答'}</ActionMenuItem>
      {!active && message.generation && <GenerationMetadata generation={message.generation} />}
      <ActionMenuItem disabled={active || busy || !navigator.onLine} onSelect={remove} aria-label="删除消息"><Trash2 className="h-[0.9375rem] w-[0.9375rem]" />删除消息</ActionMenuItem>
    </ActionMenu>
    {!user && branchSelected && <span className="ml-1 text-xs text-muted-foreground">当前分支</span>}
  </div>;
}
