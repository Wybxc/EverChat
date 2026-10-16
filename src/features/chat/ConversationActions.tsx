import { useState, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Link,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  LocateFixed,
  Square,
  Sparkles,
} from 'lucide-react';
import type { ConversationInfo } from '../../../shared/conversation/types';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import {
  ActionMenu,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
} from '../../components/ActionMenu';
import type { ConversationActionController } from './useConversationActions';

export function ConversationActions({
  conversation,
  disabled,
  actions,
  children,
  exports,
  label = '更多会话操作',
  className,
  activity,
}: {
  conversation?: ConversationInfo;
  disabled: boolean;
  actions: ConversationActionController;
  children?: ReactNode;
  exports?: ReactNode;
  label?: string;
  className?: string;
  activity?: ConversationActivity;
}) {
  const [menuOpen, setMenuOpen] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const [task, setTask] = useState<Exclude<ConversationActivity, { status: 'idle' }>>();
  const busy = Boolean(conversation && actions.busy.has(conversation.id));
  const perform = async (action: () => Promise<void>, cloud = true) => {
    if (!conversation || (cloud && busy)) return;
    setError('');
    try {
      if (cloud) await actions.perform(conversation.id, action);
      else await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '修改失败，请重试。');
      setMenuOpen(true);
    }
  };
  return (
    <ActionMenu
      label={label}
      icon={<MoreHorizontal className="size-[1.1875rem]" />}
      className={className}
      open={menuOpen}
      onOpenChange={(next) => {
        setMenuOpen(next);
        if (next) {
          setCopied(false);
          setTask(activity?.status !== 'idle' ? activity : undefined);
        }
      }}
    >
      {children}
      {conversation && (
        <>
          <ActionMenuLabel>整理</ActionMenuLabel>
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => actions.open('rename', conversation)}
          >
            <Pencil className="size-4" />
            重命名
          </ActionMenuItem>
          {actions.titleConfigured && actions.generateTitle && (
            <ActionMenuItem
              disabled={
                disabled ||
                busy ||
                ['queued', 'running'].includes(conversation.titleTask?.status ?? '')
              }
              onSelect={() => void perform(() => actions.generateTitle!(conversation.id))}
            >
              <Sparkles className="size-4" />
              {['queued', 'running'].includes(conversation.titleTask?.status ?? '')
                ? '标题生成中'
                : conversation.titleSource === 'ai'
                  ? '重新生成标题'
                  : '生成标题'}
            </ActionMenuItem>
          )}
          {conversation.titleTask?.status === 'failed' && (
            <div role="status" className="max-w-64 px-2 py-1 text-xs text-muted-foreground">
              {conversation.titleTask.error}
            </div>
          )}
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() =>
              void perform(() => actions.update(conversation.id, { pinned: !conversation.pinned }))
            }
          >
            {conversation.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {conversation.pinned ? '取消置顶' : '置顶'}
          </ActionMenuItem>
          <ActionMenuLabel>复用</ActionMenuLabel>
          <ActionMenuItem
            keepOpen
            onSelect={() =>
              void perform(async () => {
                await actions.copyLink(conversation.id);
                setCopied(true);
              }, false)
            }
          >
            {copied ? <Check className="size-4" /> : <Link className="size-4" />}
            {copied ? '链接已复制' : '复制链接'}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => void perform(() => actions.duplicate(conversation.id))}
          >
            <Copy className="size-4" />
            复制对话
          </ActionMenuItem>
        </>
      )}
      {exports && (
        <>
          <ActionMenuLabel>导出</ActionMenuLabel>
          {exports}
        </>
      )}
      {conversation && task && (
        <>
          <ActionMenuLabel>任务</ActionMenuLabel>
          <ActionMenuItem onSelect={() => actions.viewTask(conversation.id, task)}>
            <LocateFixed className="size-4" />
            查看生成位置
          </ActionMenuItem>
          <ActionMenuItem
            disabled={
              disabled || busy || (activity?.status === 'stopping' && activity.runId === task.runId)
            }
            onSelect={() => void perform(() => actions.stopTask(conversation.id, task))}
          >
            <Square className="size-4" />
            {activity?.status === 'stopping' && activity.runId === task.runId
              ? '停止中'
              : '停止生成'}
          </ActionMenuItem>
        </>
      )}
      {conversation && (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() =>
              void perform(() =>
                actions.update(conversation.id, { archived: !conversation.archived }),
              )
            }
          >
            {conversation.archived ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            {conversation.archived ? '取消归档' : '归档'}
          </ActionMenuItem>
          <ActionMenuSeparator />
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => actions.open('delete', conversation)}
          >
            <Trash2 className="size-4" />
            删除对话
          </ActionMenuItem>
        </>
      )}
      {error && (
        <div role="alert" className="px-2 py-1 text-xs">
          {error}
        </div>
      )}
    </ActionMenu>
  );
}
