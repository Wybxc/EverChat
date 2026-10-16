import { messageText } from '../../shared/conversation/content';
import type { Message, SubmitInput } from '../../shared/conversation/types';
import { MAX_MESSAGES } from '../platform/resource-limits';

export function planSubmissionParent(messages: Message[], input: SubmitInput): { parent?: Message; previous?: Message; original?: Message; content: string; userParentId: string | null } | { error: string; status: number } {
  const ordinary = !input.retryOf && !input.revisionOf;
  if (input.parentId !== undefined && !ordinary) return { error: '修订或重新生成不能同时指定父消息。', status: 400 };
  if (ordinary && input.parentId === undefined) return { error: '发送消息必须指定父消息。', status: 400 };
  const requestedParent = input.parentId ? messages.find((message) => message.id === input.parentId && message.status === 'completed' && !message.deletedAt && !message.summary) : undefined;
  if (input.parentId && !requestedParent) return { error: '找不到可继续的父消息。', status: 404 };
  if (ordinary && input.parentId === null && messages.some((message) => !message.summary)) return { error: '请指定当前分支的父消息，或新建对话。', status: 409 };
  let parent: Message | undefined;
  let previous: Message | undefined;
  if (input.retryOf) {
    previous = messages.find((m) => m.id === input.retryOf && m.role === 'assistant' && !m.deletedAt && !m.summary);
    parent = messages.find((m) => m.id === previous?.parentId);
    if (!previous || !parent || parent.deletedAt) return { error: '找不到要重新生成的消息。', status: 404 };
  }
  const original = input.revisionOf ? messages.find((m) => m.id === input.revisionOf && m.role === 'user' && !m.deletedAt) : undefined;
  if (input.revisionOf && !original) return { error: '找不到要编辑的消息。', status: 404 };
  if (messages.length + (parent ? 1 : 2) > MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
  const content = parent ? messageText(parent) : input.content?.trim() ?? '';
  if (input.retryOf && (input.imageIds !== undefined || input.fileIds !== undefined)) return { error: '重新生成不能更换原提问的附件。', status: 400 };
  const userParentId = original ? original.parentId : requestedParent?.id ?? null;
  return { parent, previous, original, content, userParentId };
}
