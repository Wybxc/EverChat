import { MoreHorizontal,RefreshCw,Trash2 } from 'lucide-react';
import { messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import { type Message } from '../../../shared/conversation/types';
import { ActionMenu,ActionMenuItem } from '../../components/ActionMenu';
import { Disclosure } from '../../components/Disclosure';
import { GenerationMetadata } from './GenerationMetadata';
import { MarkdownContent } from './rendering/MarkdownContent';
import { useFollowScroll } from './useFollowScroll';


export function SummaryView({ message, busy, onRetry, onDelete, selected }: { message: Message; busy: boolean; onRetry: () => void; onDelete: () => void; selected: boolean }) {
  const scroll = useFollowScroll(message.id);
  if (message.deletedAt) return <article data-testid="summary-message" data-message-id={message.id} className="text-xs text-muted-foreground">摘要已删除或失效</article>;
  return <article data-testid="summary-message" data-message-id={message.id} data-status={message.status} className="space-y-2">
    <div className="flex items-start gap-1">
      <Disclosure stateKey={`summary:${message.id}`} defaultOpen={isActive(message)} className="min-w-0 flex-1" title={<>{message.summary!.automatic ? '自动历史摘要' : '历史摘要'} · 覆盖 {message.summary!.sourceIds.length} 条{isActive(message) ? ' · 生成中' : message.status === 'failed' ? ' · 生成失败' : message.status === 'cancelled' ? ' · 已停止' : selected ? ' · 当前分支使用' : ' · 未用于当前分支'}</>}>
        <div ref={scroll.viewportRef} className="max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain"><div ref={scroll.contentRef}>{messageText(message) && <MarkdownContent content={messageText(message)} streaming={isActive(message)} />}</div></div>
      </Disclosure>
      <ActionMenu label="更多摘要操作" icon={<MoreHorizontal className="h-[1.0625rem] w-[1.0625rem]" />} placement="dropdown-top dropdown-end">
        <ActionMenuItem disabled={busy || !navigator.onLine} onSelect={onRetry}><RefreshCw className="h-[0.9375rem] w-[0.9375rem]" />重新生成摘要</ActionMenuItem>
        {!isActive(message) && message.generation && <GenerationMetadata generation={message.generation} />}
        <ActionMenuItem disabled={busy || !navigator.onLine} onSelect={onDelete}><Trash2 className="h-[0.9375rem] w-[0.9375rem]" />删除摘要</ActionMenuItem>
      </ActionMenu>
    </div>
    {message.error && <p role="alert" className="text-sm">{message.error}</p>}
    {message.status === 'cancelled' && <p className="text-sm">已停止，摘要未用于上下文。</p>}
  </article>;
}
