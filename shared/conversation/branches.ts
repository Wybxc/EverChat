import { AppError, problem } from '../errors/descriptor';
import type { Message } from './types';

type BranchNode = Pick<Message, 'id' | 'parentId' | 'role' | 'deletedAt'>;
interface BranchIndex {
  nodes: Map<string, BranchNode>;
  children: Map<string | null, string[]>;
  choices: Map<string | null, string[]>;
  positions: Map<string, number>;
  roles: Map<string | null, Message['role'] | null>;
  browsable: Set<string>;
  invalid: Set<string>;
  order: string[];
}
export type BranchPreferences = Record<string, string>;
export const parentKey = (id: string | null) => id ?? 'root';

/** Derived summaries never form edges in the chat tree. Tombstones still connect descendants. */
export function indexBranches(messages: readonly Message[]): BranchIndex {
  const nodes = new Map<string, BranchNode>(),
    children = new Map<string | null, string[]>();
  for (const message of messages) {
    if (message.summary) continue;
    nodes.set(message.id, {
      id: message.id,
      parentId: message.parentId,
      role: message.role,
      deletedAt: message.deletedAt,
    });
    const siblings = children.get(message.parentId) ?? [];
    siblings.push(message.id);
    children.set(message.parentId, siblings);
  }
  const valid = new Set<string>(),
    invalid = new Set<string>();
  for (const id of nodes.keys()) {
    if (valid.has(id) || invalid.has(id)) continue;
    const visiting = new Set<string>();
    let current: string | null = id;
    while (
      current !== null &&
      nodes.has(current) &&
      !valid.has(current) &&
      !invalid.has(current) &&
      !visiting.has(current)
    ) {
      visiting.add(current);
      current = nodes.get(current)!.parentId;
    }
    const target = current === null || valid.has(current) ? valid : invalid;
    for (const visited of visiting) target.add(visited);
  }
  const browsable = new Set<string>();
  // Mark live nodes and their ancestors. Each edge is visited at most once.
  for (const node of nodes.values()) {
    if (node.deletedAt || invalid.has(node.id)) continue;
    let current: BranchNode | undefined = node;
    while (current && !browsable.has(current.id)) {
      browsable.add(current.id);
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
  }
  const choices = new Map<string | null, string[]>(),
    positions = new Map<string, number>(),
    roles = new Map<string | null, Message['role'] | null>();
  for (const [parent, siblings] of children) {
    const visible = siblings.filter((id) => browsable.has(id));
    choices.set(parent, visible);
    visible.forEach((id, position) => positions.set(id, position));
    const role = visible.length ? nodes.get(visible[0])!.role : null;
    roles.set(parent, visible.every((id) => nodes.get(id)!.role === role) ? role : null);
  }
  return {
    nodes,
    children,
    choices,
    positions,
    roles,
    browsable,
    invalid,
    order: [...nodes.keys()],
  };
}

/** Content/stream changes keep the topology index stable. */
export function branchIndexer() {
  let previous: BranchIndex | undefined;
  return (messages: readonly Message[]) => {
    let count = 0;
    const same =
      previous &&
      messages.every((message) => {
        if (message.summary) return true;
        const old = previous!.nodes.get(message.id);
        return (
          previous!.order[count++] === message.id &&
          old?.parentId === message.parentId &&
          old.role === message.role &&
          old.deletedAt === message.deletedAt
        );
      }) &&
      count === previous.nodes.size;
    if (!same) previous = indexBranches(messages);
    return previous!;
  };
}

export function branchIds(index: BranchIndex, head: string | null): string[] {
  if (head === null) return [];
  if (!index.nodes.has(head) || index.invalid.has(head))
    throw new AppError(problem('BRANCH_INVALID'), '消息分支关系无效，无法显示或发送。');
  const path: string[] = [];
  let current = index.nodes.get(head);
  while (current) {
    path.push(current.id);
    current = current.parentId ? index.nodes.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function branchChoices(index: BranchIndex, id: string) {
  const node = index.nodes.get(id);
  return node ? (index.choices.get(node.parentId) ?? []) : [];
}

export function descendBranch(
  index: BranchIndex,
  start: string,
  preferences: BranchPreferences,
): string {
  if (!index.browsable.has(start)) throw new AppError(problem('NOT_FOUND'), '找不到可浏览的分支。');
  let head = start;
  while (true) {
    const children = index.choices.get(head) ?? [];
    if (!children.length) return head;
    const preferred = preferences[parentKey(head)];
    head = children.includes(preferred) ? preferred : children.at(-1)!;
  }
}

export function rememberBranch(
  index: BranchIndex,
  head: string,
  preferences: BranchPreferences,
): BranchPreferences {
  let next = preferences;
  for (const id of branchIds(index, head)) {
    const key = parentKey(index.nodes.get(id)!.parentId);
    if (next[key] === id) continue;
    if (next === preferences) next = { ...preferences };
    next[key] = id;
  }
  return next;
}

export function recoverBranch(
  index: BranchIndex,
  head: string | null,
  preferences: BranchPreferences,
): string | null {
  if (head && index.invalid.has(head))
    throw new AppError(problem('BRANCH_INVALID'), '消息分支关系无效，无法显示或发送。');
  if (head && index.browsable.has(head)) return head;
  let node = head ? index.nodes.get(head) : undefined;
  while (node) {
    const siblings = index.children.get(node.parentId) ?? [],
      position = siblings.indexOf(node.id);
    const replacement =
      siblings
        .slice(0, position)
        .reverse()
        .find((id) => index.browsable.has(id)) ??
      siblings.slice(position + 1).find((id) => index.browsable.has(id));
    if (replacement) return descendBranch(index, replacement, preferences);
    node = node.parentId ? index.nodes.get(node.parentId) : undefined;
    if (node && index.browsable.has(node.id)) return node.id;
  }
  const fallback = [...index.order].reverse().find((id) => index.browsable.has(id));
  if (!fallback && index.invalid.size)
    throw new AppError(problem('BRANCH_INVALID'), '消息分支关系无效，无法显示或发送。');
  return fallback ?? null;
}

export function continuationParent(path: readonly Message[]): string | null {
  return (
    [...path]
      .reverse()
      .find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)
      ?.id ?? null
  );
}

export function summariesOnBranch(messages: readonly Message[], path: readonly Message[]) {
  return messages.filter(
    (message) =>
      message.summary &&
      message.summary.sourceIds.length <= path.length &&
      message.summary.sourceIds.every((id, i) => path[i].id === id),
  );
}
