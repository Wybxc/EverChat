import { CircleDashed, Clock3, Pin, Square } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import type { ConversationInfo } from '../../../shared/conversation/types';
import { conversationUrl } from '../../app/useConversationRoute';
import type { Pending } from '../chat/cache';
import { ConversationActions } from '../chat/ConversationActions';
import type { ConversationActionController } from '../chat/useConversationActions';

export function ConversationListItem({
  conversation,
  selected,
  pending,
  saved,
  disabled,
  actions,
  select,
  activity,
  fresh,
}: {
  conversation: ConversationInfo;
  selected: boolean;
  pending?: Pending;
  saved: boolean;
  disabled: boolean;
  actions: ConversationActionController;
  select: () => void;
  activity?: ConversationActivity;
  fresh: boolean;
}) {
  const active = activity && activity.status !== 'idle' ? activity : undefined;
  const label = active
    ? !fresh
      ? '生成状态待同步'
      : active.status === 'running'
        ? '生成中'
        : active.status === 'stopping'
          ? '停止中'
          : '等待生成'
    : undefined;
  return (
    <div className="sidebar-row flex min-w-0 items-center rounded-lg" data-current={selected}>
      <a
        href={conversationUrl(conversation.id)}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          select();
        }}
        aria-current={selected ? 'page' : undefined}
        aria-description={conversation.pinned ? '已置顶' : undefined}
        title={conversation.title}
        className="sidebar-link min-w-0 flex-1 font-normal"
      >
        <span className="truncate">{conversation.title}</span>
        {conversation.pinned && <Pin aria-hidden="true" className="size-3 shrink-0" />}
      </a>
      {active && (
        <span
          role="status"
          aria-label={label}
          title={label}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          {!fresh ? (
            <CircleDashed aria-hidden="true" className="size-3.5" />
          ) : active.status === 'running' ? (
            <Spinner className="size-3.5 motion-reduce:animate-none" />
          ) : active.status === 'stopping' ? (
            <Square aria-hidden="true" className="size-3" />
          ) : (
            <Clock3 aria-hidden="true" className="size-3.5" />
          )}
        </span>
      )}
      {pending && !active && (
        <span
          role="status"
          aria-label={pending.error ? '发送失败' : '待发送'}
          title={pending.error ? '发送失败' : '待发送'}
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
      )}
      {saved && (
        <ConversationActions
          conversation={conversation}
          disabled={disabled}
          actions={actions}
          activity={activity}
          label={`${conversation.title}的更多操作`}
          className="conversation-row-menu shrink-0"
        />
      )}
    </div>
  );
}
