import { messageText } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import type { Message } from '../../../shared/conversation/types';
import { reasoningBlocks } from '../../../shared/web-tools/reasoning-flow';
import { Disclosure } from '../../components/Disclosure';
import { ToolActivity, ToolFailures } from '../web-tools/ToolActivity';
import { MarkdownContent } from './rendering/MarkdownContent';
import { useFollowScroll } from './useFollowScroll';

export function ReasoningContent({ message }: { message: Message }) {
  const scroll = useFollowScroll(message.id);
  const reasoning = messageText(message, 'reasoning');
  if (!reasoning && !message.tools?.calls.length) return null;
  const blocks = reasoningBlocks(reasoning, message.tools);
  return (
    <>
      <Disclosure
        stateKey={`reasoning:${message.id}`}
        defaultOpen
        title="思考过程"
        className="mb-2"
        testId="message-reasoning"
      >
        <div
          ref={scroll.viewportRef}
          className="reasoning-content max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain break-words"
        >
          <div
            ref={scroll.contentRef}
            data-search-content={`${message.id}:reasoning`}
            className="space-y-2"
          >
            {blocks.map((block) =>
              block.type === 'reasoning' ? (
                <div
                  key={`reasoning:${block.round}`}
                  data-reasoning-part={block.round}
                  hidden={!block.text}
                >
                  {block.text && (
                    <MarkdownContent
                      content={block.text}
                      streaming={
                        !block.complete && isActive(message) && message.streamVersion != null
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
              ),
            )}
          </div>
        </div>
      </Disclosure>
      <ToolFailures calls={message.tools?.calls ?? []} messageId={message.id} />
    </>
  );
}
