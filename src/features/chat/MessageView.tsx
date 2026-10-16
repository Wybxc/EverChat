import { Spinner } from '@/components/ui/spinner';
import { Infinity as InfinityIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { messageFiles, messageImages, messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import { type Message } from '../../../shared/conversation/types';
import { Disclosure } from '../../components/Disclosure';
import { DocumentPreviews } from '../attachments/DocumentPreviews';
import { ImagePreviews } from '../attachments/ImagePreviews';
import { ToolActivity } from '../web-tools/ToolActivity';
import { BranchSwitcher, type BranchNavigation } from './BranchSwitcher';
import { MessageActions } from './MessageActions';
import { MarkdownContent } from './rendering/MarkdownContent';
import { useFollowScroll } from './useFollowScroll';

export function MessageView({
  conversationId,
  message,
  busy,
  onRetry,
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
}: {
  conversationId: string;
  message: Message;
  busy: boolean;
  onRetry: () => void;
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
}) {
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false),
    [forkError, setForkError] = useState('');
  const forkLock = useRef(false);
  const reasoningScroll = useFollowScroll(message.id);
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
      setForkError(failure instanceof Error ? failure.message : '复制失败，请重试。');
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
        <p>消息已删除</p>
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
        className="group ml-auto w-fit max-w-[90%] sm:max-w-[82%]"
      >
        <DocumentPreviews conversationId={conversationId} files={messageFiles(message)} />
        <ImagePreviews conversationId={conversationId} images={messageImages(message)} />
        {messageText(message) && (
          <div
            data-search-content={`${message.id}:content`}
            className="rounded-[1.375rem] bg-user-message text-user-message-foreground px-4 py-2.5 text-base leading-7 whitespace-pre-wrap break-words sm:px-4 sm:py-2.5"
          >
            {messageText(message)}
          </div>
        )}
        {actions}
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
          {message.modelName || message.model || 'EverChat'}
        </span>
        {isActive(message) && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Spinner />
            {message.waitingForSummary
              ? '等待历史摘要'
              : message.status === 'queued'
                ? '排队中'
                : '生成中'}
          </span>
        )}
        {message.status === 'failed' && toolErrorVisible && <span>生成失败</span>}
      </div>
      {messageText(message, 'reasoning') && (
        <Disclosure
          stateKey={`reasoning:${message.id}`}
          defaultOpen
          title="思考过程"
          className="mb-2"
          testId="message-reasoning"
        >
          <div
            ref={reasoningScroll.viewportRef}
            className="reasoning-content max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain break-words"
          >
            <div ref={reasoningScroll.contentRef}>
              <MarkdownContent
                content={messageText(message, 'reasoning')}
                searchId={`${message.id}:reasoning`}
                streaming={isActive(message)}
              />
            </div>
          </div>
        </Disclosure>
      )}
      <ToolActivity task={message.tools} stateKey={`tools:${message.id}`} />
      {messageText(message) ? (
        <MarkdownContent
          content={messageText(message)}
          searchId={`${message.id}:content`}
          streaming={isActive(message)}
        />
      ) : isActive(message) && !messageText(message, 'reasoning') && !message.tools ? (
        <p className="py-2 text-sm text-muted-foreground">
          {message.waitingForSummary ? '压缩历史后开始回答…' : '准备中…'}
        </p>
      ) : null}
      {message.status === 'failed' && !toolErrorVisible && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-destructive/5 px-3 py-2 text-xs font-medium leading-6 text-foreground"
        >
          {message.error ?? '生成失败，已保存部分内容。'}
        </p>
      )}
      {message.status === 'cancelled' && (
        <p className="mt-4 text-xs text-muted-foreground">已停止</p>
      )}
      {actions}
      {forkError && (
        <p role="alert" className="mt-1 text-xs">
          {forkError}
        </p>
      )}
    </article>
  );
}
