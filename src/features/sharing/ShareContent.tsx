import type { ShareBlock } from '../../../shared/sharing/types';
import { MarkdownContent } from '../chat/rendering/MarkdownContent';

export function ShareContent({ blocks }: { blocks: ShareBlock[] }) {
  const messages: {
    index: number;
    role: 'user' | 'assistant';
    text: string;
    reasoning: string;
    omitted: number;
  }[] = [];
  for (const block of blocks) {
    let message = messages.at(-1);
    if (message?.index !== block.message) {
      message = { index: block.message, role: block.role, text: '', reasoning: '', omitted: 0 };
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
          className="min-w-0 space-y-2"
        >
          <h2 className="text-xs font-medium text-muted-foreground">
            {message.role === 'user' ? '提问' : '回答'}
          </h2>
          {message.reasoning && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">思考内容</summary>
              <div className="pt-2">
                <MarkdownContent content={message.reasoning} streaming={false} publicContent />
              </div>
            </details>
          )}
          <MarkdownContent content={message.text} streaming={false} publicContent />
          {message.omitted > 0 && (
            <p className="text-xs text-muted-foreground">已省略 {message.omitted} 个附件</p>
          )}
        </article>
      ))}
    </div>
  );
}
