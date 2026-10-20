import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import './locales';
import { messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import type { Message } from '../../../shared/conversation/types';
import { reasoningBlocks } from '../../../shared/web-tools/reasoning-flow';
import { useDisclosureState } from '../../components/Disclosure';
import { ToolActivity, ToolFailures } from '../web-tools/ToolActivity';
import { MarkdownContent } from './rendering/MarkdownContent';
import { ChatScrollProvider, useChatScroll } from './ChatScroll';
import {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from '@/components/ui/message-scroller';

export function ReasoningContent({ message }: { message: Message }) {
  if (!messageText(message, 'reasoning') && !message.tools?.calls.length) return null;
  return (
    <ChatScrollProvider>
      <ReasoningPane message={message} />
    </ChatScrollProvider>
  );
}

function ReasoningPane({ message }: { message: Message }) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const scroll = useChatScroll(message.id);
  const [open, setOpen] = useDisclosureState(`reasoning:${message.id}`, true);
  const reasoning = messageText(message, 'reasoning');
  if (!reasoning && !message.tools?.calls.length) return null;
  const blocks = reasoningBlocks(reasoning, message.tools);
  return (
    <>
      <Trace>
        <TraceCollapsible
          open={open}
          onOpenChange={setOpen}
          className="mb-2"
          data-testid="message-reasoning"
        >
          <TraceCollapsibleTrigger>
            <TraceLine status={isActive(message) ? 'running' : undefined}>
              <TraceIcon>
                <Brain />
              </TraceIcon>
              <TraceTitle>{t(($) => $.reasoningProcess)}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent forceMount hidden={!open} className="ml-0 pl-3 pr-0">
            <MessageScroller className="h-auto">
              <MessageScrollerViewport
                aria-label={t(($) => $.reasoningProcess)}
                ref={scroll.viewportRef}
                className="reasoning-content h-auto max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain break-words"
              >
                <MessageScrollerContent
                  role="presentation"
                  ref={scroll.contentRef}
                  data-search-content={`${message.id}:reasoning`}
                  className="flex flex-col gap-2"
                >
                  {blocks.map((block) => (
                    <MessageScrollerItem
                      key={`${block.type}:${block.round}`}
                      messageId={`${block.type}:${block.round}`}
                    >
                      {block.type === 'reasoning' ? (
                        <div
                          key={`reasoning:${block.round}`}
                          data-reasoning-part={block.round}
                          hidden={!block.text}
                        >
                          {block.text && (
                            <MarkdownContent
                              content={block.text}
                              streaming={
                                !block.complete &&
                                isActive(message) &&
                                message.streamVersion != null
                              }
                            />
                          )}
                        </div>
                      ) : (
                        <ToolActivity
                          key={`tools:${block.round}`}
                          calls={block.calls}
                          messageId={message.id}
                        />
                      )}
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
      <ToolFailures calls={message.tools?.calls ?? []} messageId={message.id} />
    </>
  );
}
