import { useTranslation } from 'react-i18next';
import './locales';
import { IconButton } from '../../components/IconButton';
import { ActionMenuItem, ActionMenuSeparator } from '../../components/ActionMenu';
import { Spinner } from '@/components/ui/spinner';
import {
  Check,
  Copy,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Quote,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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
  const { t } = useTranslation('chat', { useSuspense: false });

  const active = isActive(message),
    user = message.role === 'user';
  return (
    <div
      className={`message-actions mt-1 flex flex-wrap items-center gap-0.5 text-muted-foreground ${user ? 'justify-end' : ''}`}
    >
      <BranchSwitcher {...branch} />
      {hasFollowing && (
        <button
          type="button"
          className="message-following rounded-md px-2 text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={showFollowing}
        >
          {t(($) => $.viewContinuation)}
        </button>
      )}
      <IconButton type="button" onClick={copy} label={t(($) => $.copyMessage)}>
        {copied ? (
          <Check className="h-[0.875rem] w-[0.875rem]" />
        ) : (
          <Copy className="h-[0.875rem] w-[0.875rem]" />
        )}
      </IconButton>
      {user ? (
        <IconButton type="button" onClick={quote} label={t(($) => $.quoteMessage)}>
          <Quote className="h-[0.875rem] w-[0.875rem]" />
        </IconButton>
      ) : (
        <IconButton
          type="button"
          label={t(($) => $.regenerate)}
          disabled={active || busy || !canRetry}
          onClick={retry}
        >
          <RefreshCw className="h-[0.875rem] w-[0.875rem]" />
        </IconButton>
      )}
      <IconButton
        type="button"
        onClick={edit}
        data-message-edit=""
        label={user ? t(($) => $.editQuestion) : t(($) => $.editAnswer)}
        disabled={active || busy || (!user && !navigator.onLine)}
      >
        <Pencil className="size-3.5" />
      </IconButton>
      <ActionMenu
        label={t(($) => $.moreMessageActions)}
        triggerData="message"
        icon={<MoreHorizontal className="h-[1.0625rem] w-[1.0625rem]" />}
        placement="dropdown-top dropdown-end"
      >
        {!user && (
          <ActionMenuItem onSelect={quote} aria-label={t(($) => $.quoteMessage)}>
            <Quote className="h-[0.9375rem] w-[0.9375rem]" />
            {t(($) => $.quote)}
          </ActionMenuItem>
        )}
        <ActionMenuItem
          disabled={!canFork || forking}
          onSelect={fork}
          aria-label={t(($) => $.copyToNewChat)}
        >
          {forking ? <Spinner /> : <Copy className="h-[0.9375rem] w-[0.9375rem]" />}
          {t(($) => $.copyToNewChat)}
        </ActionMenuItem>
        {!user && message.status === 'completed' && (
          <>
            <ActionMenuSeparator />
            <ActionMenuItem onSelect={selectBranch}>
              <GitBranch className="size-4" />
              {t(($) => $.continueHere)}
            </ActionMenuItem>
          </>
        )}
        <ActionMenuSeparator />
        <ActionMenuItem
          disabled={active || busy || !navigator.onLine}
          onSelect={remove}
          aria-label={t(($) => $.deleteMessage)}
        >
          <Trash2 className="h-[0.9375rem] w-[0.9375rem]" />
          {t(($) => $.deleteMessage)}
        </ActionMenuItem>
      </ActionMenu>
      {!user && <GenerationMetadata message={message} />}
      {!user && message.revisionOf && !message.generation && (
        <span className="px-1 text-xs">{t(($) => $.manuallyEdited)}</span>
      )}
    </div>
  );
}
