import { useTranslation } from 'react-i18next';
import './locales';
import { Spinner } from '@/components/ui/spinner';
import { Infinity as InfinityIcon } from 'lucide-react';
import { useRef, useState, type Ref } from 'react';
import { messageFiles, messageImages, messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import { type Message } from '../../../shared/conversation/types';
import { DocumentPreviews } from '../attachments/DocumentPreviews';
import { ImagePreviews } from '../attachments/ImagePreviews';
import { BranchSwitcher, type BranchNavigation } from './BranchSwitcher';
import { MessageActions } from './MessageActions';
import { MarkdownContent } from './rendering/MarkdownContent';
import { ReasoningContent } from './ReasoningContent';
import { ProviderFailureView } from '../providers/ProviderFailureView';
import { MessageEditor } from './MessageEditor';
import { UserMessageBubble } from './UserMessageBubble';

export function MessageView({
  navigationRef,
  conversationId,
  message,
  providerName,
  busy,
  onRetry,
  onProviderSettings,
  onEdit,
  onQuote,
  onDelete,
  canRetry,
  branch,
  hasFollowing,
  onSelectBranch,
  onShowFollowing,
  canFork,
  onFork,
  editing,
}: {
  navigationRef?: Ref<HTMLElement>;
  conversationId: string;
  message: Message;
  providerName?: string;
  busy: boolean;
  onRetry: () => void;
  onProviderSettings?: () => void;
  onEdit: () => void;
  onQuote: () => void;
  onDelete: () => void;
  canRetry: boolean;
  branch: BranchNavigation;
  hasFollowing: boolean;
  onSelectBranch: () => void;
  onShowFollowing: () => void;
  canFork: boolean;
  onFork: () => Promise<void>;
  editing?: {
    content: string;
    change: (content: string) => void;
    save: () => Promise<void>;
    cancel: () => void;
  };
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false),
    [forkError, setForkError] = useState('');
  const forkLock = useRef(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(messageText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard can be unavailable outside HTTPS. */
    }
  };
  const fork = async () => {
    if (forkLock.current || !canFork) return;
    forkLock.current = true;
    setForking(true);
    setForkError('');
    try {
      await onFork();
    } catch (failure) {
      setForkError(failure instanceof Error ? failure.message : t(($) => $.copyFailed));
    } finally {
      forkLock.current = false;
      setForking(false);
    }
  };
  if (message.deletedAt)
    return (
      <article
        data-testid={`${message.role}-message`}
        data-message-id={message.id}
        data-deleted="true"
        className={`py-2 text-xs text-muted-foreground ${message.role === 'user' ? 'text-right' : ''}`}
      >
        <p>{t(($) => $.messageDeleted)}</p>
        <div className={`flex ${message.role === 'user' ? 'justify-end' : ''}`}>
          <BranchSwitcher {...branch} />
        </div>
      </article>
    );
  const actions = (
    <MessageActions
      message={message}
      busy={busy}
      copied={copied}
      forking={forking}
      canFork={canFork}
      canRetry={canRetry}
      branch={branch}
      hasFollowing={hasFollowing}
      showFollowing={onShowFollowing}
      copy={() => void copy()}
      quote={onQuote}
      edit={onEdit}
      remove={onDelete}
      fork={() => void fork()}
      retry={onRetry}
      selectBranch={onSelectBranch}
    />
  );
  if (message.role === 'user')
    return (
      <article
        data-testid="user-message"
        data-message-id={message.id}
        className={`group ml-auto ${editing ? 'w-full' : 'w-fit'} max-w-[90%] sm:max-w-[82%]`}
      >
        <DocumentPreviews conversationId={conversationId} files={messageFiles(message)} />
        <ImagePreviews conversationId={conversationId} images={messageImages(message)} />
        {editing ? (
          <MessageEditor
            {...editing}
            user
            hasAttachments={Boolean(messageFiles(message).length || messageImages(message).length)}
          />
        ) : (
          messageText(message) && (
            <UserMessageBubble data-search-content={`${message.id}:content`}>
              {messageText(message)}
            </UserMessageBubble>
          )
        )}
        {!editing && actions}
        {forkError && (
          <p role="alert" className="mt-1 text-xs">
            {forkError}
          </p>
        )}
      </article>
    );
  const toolErrorVisible = Boolean(
    message.error &&
    message.tools?.calls.some(
      ({ result }) => result?.status === 'failed' && result.error === message.error,
    ),
  );
  return (
    <article
      ref={navigationRef}
      data-testid="assistant-message"
      data-message-id={message.id}
      data-status={message.status}
      data-durable-offset={message.durableOffset ?? 0}
      data-live-offset={message.liveOffset ?? message.durableOffset ?? 0}
      className="group min-w-0"
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <InfinityIcon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.7} />
        <span className="min-w-0 break-words font-semibold">
          {providerName && <>{providerName} · </>}
          {message.modelName || message.model || 'EverChat'}
        </span>
        {isActive(message) && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Spinner />
            {message.waitingForSummary
              ? t(($) => $.waitingSummary)
              : message.status === 'queued'
                ? t(($) => $.queued)
                : t(($) => $.generating)}
          </span>
        )}
        {message.status === 'failed' && toolErrorVisible && (
          <span>{t(($) => $.generationFailed)}</span>
        )}
      </div>
      <ReasoningContent message={message} />
      {editing ? (
        <MessageEditor {...editing} user={false} hasAttachments={false} />
      ) : messageText(message) ? (
        <MarkdownContent
          content={messageText(message)}
          searchId={`${message.id}:content`}
          streaming={isActive(message)}
        />
      ) : isActive(message) && !messageText(message, 'reasoning') && !message.tools ? (
        <p className="py-2 text-sm text-muted-foreground">
          {message.waitingForSummary ? t(($) => $.compactionBeforeAnswer) : t(($) => $.preparing)}
        </p>
      ) : null}
      {message.status === 'failed' && (!toolErrorVisible || message.generation?.failure) && (
        <ProviderFailureView
          summary={message.error ?? t(($) => $.partialAnswerSaved)}
          failure={message.generation?.failure}
          showSummary={!toolErrorVisible}
          stateKey={`failure:${message.id}`}
          onSettings={onProviderSettings}
        />
      )}
      {message.status === 'cancelled' && (
        <p className="mt-4 text-xs text-muted-foreground">{t(($) => $.stopped)}</p>
      )}
      {!editing && actions}
      {forkError && (
        <p role="alert" className="mt-1 text-xs">
          {forkError}
        </p>
      )}
    </article>
  );
}
