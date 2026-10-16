import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { branchChoices, branchIds, branchIndexer, continuationParent, descendBranch, recoverBranch, rememberBranch, type BranchPreferences } from '../shared/conversation/branches';
import type { Message } from '../shared/conversation/types';
import { read, write } from './storage';

interface ViewState { id: string | null; head: string | null; preferences: BranchPreferences; target?: string; notice: string }
const load = (id: string | null): ViewState => ({ id, head: id ? read<string | null>(`branch-view:${id}`, null) : null,
  preferences: id ? read<BranchPreferences>(`branch-choices:${id}`, {}) : {}, notice: '' });

export function useConversationBranches({ id, messages, ready, authoritative, routeHead, navigate }: {
  id: string | null; messages: Message[]; ready: boolean; authoritative: boolean; routeHead: string | null;
  navigate: (id: string | null, replace?: boolean, branch?: string | null) => void;
}) {
  const [state, setState] = useState(() => load(id));
  const navigationVersion = useRef(0);
  const currentState = state.id === id ? state : load(id);
  if (state.id !== id) setState(currentState);
  const indexer = useRef(branchIndexer());
  const index = indexer.current(ready && id ? messages : []);
  const requested = routeHead ?? currentState.head;
  let head: string | null = null, error = '', notice = currentState.notice;
  const waiting = Boolean(id && (!ready || requested && !index.nodes.has(requested) && (!authoritative || currentState.target === requested)));
  try {
    if (waiting) head = currentState.head && index.browsable.has(currentState.head) ? currentState.head : null;
    else {
      const missing = requested && !index.nodes.has(requested);
      head = recoverBranch(index, missing ? currentState.head : requested, currentState.preferences);
      if (missing && routeHead) notice = '该分支已不可用，已显示可用分支。';
    }
  } catch (failure) { error = failure instanceof Error ? failure.message : '消息分支关系无效。'; }
  const ids = useMemo(() => error ? [] : branchIds(index, head), [index, head, error]);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path = ids.map((messageId) => byId.get(messageId)!).filter(Boolean);
  const preferences = useMemo(() => head && !error ? rememberBranch(index, head, currentState.preferences) : currentState.preferences, [index, head, error, currentState.preferences]);
  const current = useRef({ id, head, index, preferences });
  current.current = { id, head, index, preferences };
  useEffect(() => {
    const pop = () => { navigationVersion.current++; };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (waiting || error || !ready || !id) return;
    if (currentState.head !== head || currentState.preferences !== preferences || currentState.target || currentState.notice !== notice) {
      setState({ id, head, preferences, notice });
      write(`branch-view:${id}`, head); write(`branch-choices:${id}`, preferences);
    }
    if (routeHead !== head) navigate(id, true, head);
  }, [id, head, preferences, currentState, waiting, error, ready, routeHead, navigate, notice]);

  const choose = useCallback((messageId: string, options: { descend?: boolean; automatic?: boolean } = {}) => {
    const value = current.current;
    if (!value.id) return;
    if (!options.automatic) navigationVersion.current++;
    const target = options.descend ? descendBranch(value.index, messageId, value.preferences) : messageId;
    const known = value.index.nodes.has(target);
    const nextPreferences = known ? rememberBranch(value.index, target, value.preferences) : value.preferences;
    setState({ id: value.id, head: known ? target : value.head, preferences: nextPreferences, target: known ? undefined : target, notice: '' });
    write(`branch-view:${value.id}`, target); write(`branch-choices:${value.id}`, nextPreferences);
    navigate(value.id, Boolean(options.automatic), target);
  }, [navigate]);
  return { index, path, ids, head, error, notice, waiting, choose, navigationVersion,
    continuationParentId: continuationParent(path), choices: (messageId: string) => branchChoices(index, messageId),
    dismissNotice: () => setState((value) => ({ ...value, notice: '' })) };
}
