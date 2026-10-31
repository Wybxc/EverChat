import { answerStages } from '../conversation/continuation';
import { branchPath } from '../conversation/branch-path';
import { messageAttachments, messageText } from '../conversation/content';
import type { Message } from '../conversation/types';
import { AppError, problem } from '../errors/descriptor';
import type { ShareBlock } from './types';

/** Construct a whitelist projection. No original IDs, model settings or tool payloads cross it. */
export function projectShare(messages: Message[], headId: string) {
  const path = branchPath(messages, headId);
  if (path.some((m) => m.deletedAt || m.status !== 'completed'))
    throw new AppError(problem('SHARE_INCOMPLETE'), '请等待当前分支完成，或选择已完成的回答。');
  const visible = path.filter((m) => !m.summary);
  if (!visible.length)
    throw new AppError(problem('SHARE_INCOMPLETE'), '当前分支没有可分享的消息。');
  const projected = visible.map((message) => ({
    role: message.role,
    modelName:
      message.role === 'assistant'
        ? [
            ...new Set(
              answerStages(message)
                .map((stage) => stage.modelName || stage.model)
                .filter(Boolean),
            ),
          ].join(' / ') || undefined
        : undefined,
    text: messageText(message),
    reasoning: message.continuation
      ? answerStages(message)
          .filter((stage) => messageText(stage, 'reasoning'))
          .map(
            (stage, index) =>
              `### ${index + 1} · ${stage.modelName || stage.model || 'EverChat'}\n\n${messageText(stage, 'reasoning')}`,
          )
          .join('\n\n---\n\n')
      : messageText(message, 'reasoning'),
    omittedAttachments: messageAttachments(message).length,
  }));
  return {
    messageCount: projected.length,
    omittedAttachments: projected.reduce((sum, m) => sum + m.omittedAttachments, 0),
    *blocks(): Generator<ShareBlock> {
      for (const [message, item] of projected.entries()) {
        let first = true;
        for (const channel of ['reasoning', 'text'] as const) {
          const content = channel === 'text' ? item.text : item.reasoning;
          for (let start = 0; start < content.length;) {
            let end = Math.min(content.length, start + 16_384);
            if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
            yield {
              message,
              role: item.role,
              ...(first && item.modelName ? { modelName: item.modelName } : {}),
              channel,
              text: content.slice(start, end),
              omittedAttachments: first ? item.omittedAttachments : 0,
            };
            first = false;
            start = end;
          }
        }
        if (first)
          yield {
            message,
            role: item.role,
            ...(item.modelName ? { modelName: item.modelName } : {}),
            channel: 'text',
            text: '',
            omittedAttachments: item.omittedAttachments,
          };
      }
    },
  };
}
