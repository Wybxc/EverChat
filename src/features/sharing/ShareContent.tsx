import type { ShareBlock } from '../../../shared/sharing/types';
import { MarkdownContent } from '../chat/rendering/MarkdownContent';
import { UserMessageBubble } from '../chat/UserMessageBubble';
import { Infinity as InfinityIcon } from 'lucide-react';

export function ShareContent({ blocks }: { blocks: ShareBlock[] }) {
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
    <div className="space-y-6">
      {messages.map((message) => (
        <article
          key={message.index}
          aria-label={`${message.role === 'user' ? '提问' : '回答'} ${message.index + 1}`}
          data-testid={`${message.role}-message`}
          className={
            message.role === 'user' ? 'ml-auto w-fit min-w-0 max-w-[90%] sm:max-w-[82%]' : 'min-w-0'
          }
        >
          {message.role === 'user' ? (
            <>
              <h2 className="sr-only">提问</h2>
              {message.text && <UserMessageBubble>{message.text}</UserMessageBubble>}
            </>
          ) : (
            <>
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold">
                <InfinityIcon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.7} />
                <span className="min-w-0 break-words">{message.modelName || 'EverChat'}</span>
              </h2>
              {message.reasoning && (
                <details className="mb-4 text-sm text-muted-foreground">
                  <summary className="cursor-pointer">思考内容</summary>
                  <div className="pt-2">
                    <MarkdownContent content={message.reasoning} streaming={false} publicContent />
                  </div>
                </details>
              )}
              <MarkdownContent content={message.text} streaming={false} publicContent />
            </>
          )}
          {message.omitted > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">已省略 {message.omitted} 个附件</p>
          )}
        </article>
      ))}
    </div>
  );
}
