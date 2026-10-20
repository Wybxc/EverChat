import { useTranslation } from 'react-i18next';
import './locales';
import type { ShareBlock } from '../../../shared/sharing/types';
import { MarkdownContent } from '../chat/rendering/MarkdownContent';
import { UserMessageBubble } from '../chat/UserMessageBubble';
import { Brain, Infinity as InfinityIcon } from 'lucide-react';
import { Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';

export function ShareContent({ blocks }: { blocks: ShareBlock[] }) {
  const { t } = useTranslation('sharing', { useSuspense: false });

  const messages: {
    index: number;
    role: 'user' | 'assistant';
    modelName?: string;
    text: string;
    reasoning: string;
    omitted: number;
  }[] = [];
  for (const block of blocks) {
    let message = messages.at(-1);
    if (message?.index !== block.message) {
      message = {
        index: block.message,
        role: block.role,
        modelName: block.modelName,
        text: '',
        reasoning: '',
        omitted: 0,
      };
      messages.push(message);
    }
    message[block.channel] += block.text;
    message.omitted += block.omittedAttachments;
  }
  return (
    <div className="flex flex-col gap-6">
      {messages.map((message) => (
        <article
          key={message.index}
          aria-label={t(($) => $.messageLabel, {
            role: message.role === 'user' ? t(($) => $.question) : t(($) => $.answer),
            index: message.index + 1,
          })}
          data-testid={`${message.role}-message`}
          className={
            message.role === 'user' ? 'ml-auto w-fit min-w-0 max-w-[90%] sm:max-w-[82%]' : 'min-w-0'
          }
        >
          <Message align={message.role === 'user' ? 'end' : 'start'}>
            <MessageContent>
              {message.role === 'user' ? (
                <>
                  <h2 className="sr-only">{t(($) => $.question)}</h2>
                  {message.text && <UserMessageBubble>{message.text}</UserMessageBubble>}
                </>
              ) : (
                <>
                  <MessageHeader className="px-0">
                    <h2 className="flex items-center gap-2 font-semibold text-foreground">
                      <InfinityIcon
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                        strokeWidth={1.7}
                      />
                      <span className="min-w-0 break-words">{message.modelName || 'EverChat'}</span>
                    </h2>
                  </MessageHeader>
                  {message.reasoning && (
                    <Trace>
                      <TraceCollapsible data-testid="share-reasoning">
                        <TraceCollapsibleTrigger>
                          <TraceLine>
                            <TraceIcon>
                              <Brain />
                            </TraceIcon>
                            <TraceTitle>{t(($) => $.reasoning)}</TraceTitle>
                          </TraceLine>
                        </TraceCollapsibleTrigger>
                        <TraceCollapsibleContent>
                          <MarkdownContent
                            content={message.reasoning}
                            streaming={false}
                            publicContent
                          />
                        </TraceCollapsibleContent>
                      </TraceCollapsible>
                    </Trace>
                  )}
                  <Bubble variant="ghost" className="w-full">
                    <BubbleContent className="w-full">
                      <MarkdownContent content={message.text} streaming={false} publicContent />
                    </BubbleContent>
                  </Bubble>
                </>
              )}
              {message.omitted > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(($) => $.omitted, { count: message.omitted })}
                </p>
              )}
            </MessageContent>
          </Message>
        </article>
      ))}
    </div>
  );
}
