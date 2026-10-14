import { branchPath, type ChatInput, type Message } from '../shared/types';
import { messageText } from '../shared/message-content';

/** Build provider history from one parent path and append the current user input. */
export function messageContext(messages: Message[], parentId: string | null, content: string): ChatInput[] {
  const history = parentId ? branchPath(messages, parentId) : [];
  const deletedUsers = new Set(history.filter((message) => message.role === 'user' && message.deletedAt).map(({ id }) => id));
  const context: ChatInput[] = history.filter((message) => message.status === 'completed' && !message.deletedAt
    && !(message.role === 'assistant' && message.parentId && deletedUsers.has(message.parentId)))
    .map((message) => ({ role: message.role, content: messageText(message) }));
  // Bound provider context for a personal prototype. Keep the most recent turns.
  let characters = context.reduce((total, message) => total + message.content.length, 0);
  while (context.length > 40 || characters > 80_000) characters -= context.shift()!.content.length;
  while (context[0]?.role === 'assistant') context.shift();
  context.push({ role: 'user', content });
  return context;
}
