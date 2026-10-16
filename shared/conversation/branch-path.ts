import type { Message } from './types';
/** Return the chronological message path that leads to a selected branch head. */
export function branchPath(messages: Message[], headId: string): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let current = byId.get(headId);
  if (!current) throw new Error('消息分支不存在。');
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    if (current.parentId && !byId.has(current.parentId))
      throw new Error('消息分支的父消息不存在。');
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (current) throw new Error('消息分支存在循环。');
  return path.reverse();
}
