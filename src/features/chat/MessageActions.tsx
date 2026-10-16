import { IconButton } from '../../components/IconButton';
import { ActionMenuItem } from '../../components/ActionMenu';
import { Spinner } from '@/components/ui/spinner';
import { Check, Copy, MoreHorizontal, Pencil, Quote, RefreshCw, Trash2 } from 'lucide-react';
import type { Message } from '../../../shared/conversation/types';
import { isActive } from '../../../shared/conversation/message-state';
import { ActionMenu } from '../../components/ActionMenu';
import { GenerationMetadata } from './GenerationMetadata';
import { BranchSwitcher, type BranchNavigation } from './BranchSwitcher';

export function MessageActions({
  message,
  busy,
  copied,
  forking,
  canFork,
  canRetry,
  branch,
  hasFollowing,
  copy,
  quote,
  edit,
  remove,
  fork,
  retry,
  selectBranch,
  showFollowing,
}: {
  message: Message;
  busy: boolean;
  copied: boolean;
  forking: boolean;
  canFork: boolean;
  canRetry: boolean;
  branch: BranchNavigation;
  hasFollowing: boolean;
  copy: () => void;
  quote: () => void;
  edit: () => void;
  remove: () => void;
  fork: () => void;
  retry: () => void;
  selectBranch: () => void;
  showFollowing: () => void;
}) {
  const active = isActive(message),
    user = message.role === 'user';
  return (
    <div
      className={`message-actions mt-1 flex flex-wrap items-center gap-1 text-muted-foreground ${user ? 'justify-end' : ''}`}
    >
      <BranchSwitcher {...branch} />
      {hasFollowing && (
        <button
          type="button"
          className="min-h-11 rounded-md px-2 text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={showFollowing}
        >
          查看后续
        </button>
      )}
      <IconButton type="button" onClick={copy} label="复制消息">
        {copied ? (
          <Check className="h-[0.875rem] w-[0.875rem]" />
        ) : (
          <Copy className="h-[0.875rem] w-[0.875rem]" />
        )}
      </IconButton>
      {user ? (
        <IconButton type="button" onClick={quote} label="引用消息">
          <Quote className="h-[0.875rem] w-[0.875rem]" />
        </IconButton>
      ) : (
        <IconButton
          type="button"
          label="重新生成"
          disabled={active || busy || !canRetry}
          onClick={retry}
        >
          <RefreshCw className="h-[0.875rem] w-[0.875rem]" />
        </IconButton>
      )}
      <ActionMenu
        label="更多消息操作"
        icon={<MoreHorizontal className="h-[1.0625rem] w-[1.0625rem]" />}
        placement="dropdown-top dropdown-end"
      >
        {!user && (
          <ActionMenuItem onSelect={quote} aria-label="引用消息">
            <Quote className="h-[0.9375rem] w-[0.9375rem]" />
            引用
          </ActionMenuItem>
        )}
        <ActionMenuItem disabled={!canFork || forking} onSelect={fork} aria-label="复制到新对话">
          {forking ? <Spinner /> : <Copy className="h-[0.9375rem] w-[0.9375rem]" />}复制到新对话
        </ActionMenuItem>
        {!user && message.status === 'completed' && (
          <ActionMenuItem onSelect={selectBranch}>从这里继续</ActionMenuItem>
        )}
        <ActionMenuItem
          disabled={active || busy || (!user && !navigator.onLine)}
          onSelect={edit}
          aria-label={user ? '编辑为新版本' : '编辑回答'}
        >
          <Pencil className="h-[0.9375rem] w-[0.9375rem]" />
          {user ? '编辑为新版本' : '编辑回答'}
        </ActionMenuItem>
        {!active && message.generation && <GenerationMetadata generation={message.generation} />}
        <ActionMenuItem
          disabled={active || busy || !navigator.onLine}
          onSelect={remove}
          aria-label="删除消息"
        >
          <Trash2 className="h-[0.9375rem] w-[0.9375rem]" />
          删除消息
        </ActionMenuItem>
      </ActionMenu>
    </div>
  );
}
