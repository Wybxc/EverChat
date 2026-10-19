import { useTranslation } from 'react-i18next';
import { t } from './locales';
import { useState, type ReactNode } from 'react';
import {
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
  Share2,
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
  label = t(($) => $.moreChatActions),
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
  const { t } = useTranslation('chat', { useSuspense: false });

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
      setError(failure instanceof Error ? failure.message : t(($) => $.updateFailed));
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
          <ActionMenuLabel>{t(($) => $.organize)}</ActionMenuLabel>
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => actions.open('rename', conversation)}
          >
            <Pencil className="size-4" />
            {t(($) => $.rename)}
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
                ? t(($) => $.generatingTitle)
                : conversation.titleSource === 'ai'
                  ? t(($) => $.regenerateTitle)
                  : t(($) => $.generateTitle)}
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
            {conversation.pinned ? t(($) => $.unpin) : t(($) => $.pin)}
          </ActionMenuItem>
          <ActionMenuLabel>{t(($) => $.reuse)}</ActionMenuLabel>
          {actions.share && (
            <ActionMenuItem
              disabled={disabled || busy}
              onSelect={() => actions.share?.(conversation.id)}
            >
              <Share2 className="size-4" />
              {t(($) => $.shareBranch)}
            </ActionMenuItem>
          )}
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
            {copied ? t(($) => $.linkCopied) : t(($) => $.copyPrivateLink)}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => void perform(() => actions.duplicate(conversation.id))}
          >
            <Copy className="size-4" />
            {t(($) => $.copyChat)}
          </ActionMenuItem>
        </>
      )}
      {exports && (
        <>
          <ActionMenuLabel>{t(($) => $.export)}</ActionMenuLabel>
          {exports}
        </>
      )}
      {conversation && task && (
        <>
          <ActionMenuLabel>{t(($) => $.tasks)}</ActionMenuLabel>
          <ActionMenuItem onSelect={() => actions.viewTask(conversation.id, task)}>
            <LocateFixed className="size-4" />
            {t(($) => $.viewGeneration)}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={
              disabled || busy || (activity?.status === 'stopping' && activity.runId === task.runId)
            }
            onSelect={() => void perform(() => actions.stopTask(conversation.id, task))}
          >
            <Square className="size-4" />
            {activity?.status === 'stopping' && activity.runId === task.runId
              ? t(($) => $.stopping)
              : t(($) => $.stopGenerating)}
          </ActionMenuItem>
        </>
      )}
      {conversation && (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem
            disabled={disabled || busy}
            onSelect={() => actions.open('delete', conversation)}
          >
            <Trash2 className="size-4" />
            {t(($) => $.deleteChat)}
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
