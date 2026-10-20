import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMessageScroller } from '@/components/ui/message-scroller';
import type { Message } from '../../../shared/conversation/types';
import { uiMessage, type UiMessage } from '../../platform/i18n/messages';
import { answerTargets, POSITION_TOLERANCE, type AnswerAnchor } from './message-navigation';
import { messageScrollId } from './ChatScroll';
import { isScrollKey, SCROLL_INTENT_EVENT, SCROLL_LAYOUT_EVENT } from './scroll-intent';

export type ReadingAction = 'top' | 'previous' | 'next' | 'bottom';
interface NavigationState {
  visible: boolean;
  vertical: boolean;
  atTop: boolean;
  atBottom: boolean;
  previous?: string;
  next?: string;
}
const empty: NavigationState = { visible: false, vertical: false, atTop: true, atBottom: true };

/** Select actual assistant starts; movement and end padding belong to Message Scroller. */
export function useMessageNavigation({
  conversationId,
  ids,
  nodes,
  viewport,
  content,
  pauseFollowing,
  scrollToBottom,
}: {
  conversationId: string | null;
  ids: readonly string[];
  nodes: ReadonlyMap<string, Pick<Message, 'role' | 'deletedAt'>>;
  viewport: HTMLDivElement | null;
  content: HTMLElement | null;
  pauseFollowing: () => void;
  scrollToBottom: (options?: { behavior?: ScrollBehavior }) => void;
}) {
  const commands = useMessageScroller();
  const answers = useMemo(
    () => ids.filter((id) => nodes.get(id)?.role === 'assistant' && !nodes.get(id)?.deletedAt),
    [ids, nodes],
  );
  const elements = useRef(new Map<string, HTMLElement>());
  const callbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const schedule = useRef<() => void>(() => {});
  const perform = useRef<(action: ReadingAction) => void>(() => {});
  const [state, setState] = useState<NavigationState>(empty);
  const [announcement, setAnnouncement] = useState<UiMessage>('');
  const refFor = useCallback((id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (node) => {
        if (node) elements.current.set(id, node);
        else elements.current.delete(id);
        schedule.current();
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  }, []);

  useLayoutEffect(() => {
    for (const id of callbacks.current.keys())
      if (!answers.includes(id)) {
        callbacks.current.delete(id);
        elements.current.delete(id);
      }
    setAnnouncement('');
    if (!viewport || !content || !conversationId) {
      setState(empty);
      perform.current = () => {};
      return;
    }
    let frame = 0,
      settleTimer: ReturnType<typeof setTimeout> | undefined;
    let moving: { id?: string; action: ReadingAction } | undefined;
    let landed: { id: string; top: number } | undefined;
    let topLocked = false;
    const inset = () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75;
    const scrollMargin = () => inset() - parseFloat(getComputedStyle(content).paddingTop);
    const clear = (event?: Event) => {
      if (event?.type === 'keydown' && !isScrollKey(event)) return;
      clearTimeout(settleTimer);
      // Cancel the browser's native smooth motion when reading intent interrupts it.
      if (moving) viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });
      moving = undefined;
      landed = undefined;
      topLocked = false;
    };
    const anchors = (): AnswerAnchor[] => {
      const origin = viewport.getBoundingClientRect().top + viewport.clientTop;
      return answers.flatMap((id) => {
        const element = elements.current.get(id);
        return element?.isConnected && content.contains(element)
          ? [{ id, top: viewport.scrollTop + element.getBoundingClientRect().top - origin }]
          : [];
      });
    };
    const targets = () =>
      answerTargets(anchors(), viewport.scrollTop + inset(), moving?.id ?? landed?.id);
    const measure = () => {
      const style = getComputedStyle(content);
      const clearance = Math.max(0, parseFloat(style.paddingBottom) - parseFloat(style.paddingTop));
      const next: NavigationState = {
        visible: ids.length > 0 && content.offsetHeight - clearance > viewport.clientHeight + 2,
        vertical: style.getPropertyValue('--navigation-layout').trim() === 'vertical',
        atTop: viewport.scrollTop <= POSITION_TOLERANCE,
        atBottom:
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= POSITION_TOLERANCE,
        ...targets(),
      };
      setState((old) =>
        Object.keys(next).every(
          (key) => old[key as keyof NavigationState] === next[key as keyof NavigationState],
        )
          ? old
          : next,
      );
    };
    const finish = (event?: Event) => {
      if (!moving || (event && event.target !== viewport)) return;
      const { id, action } = moving;
      moving = undefined;
      clearTimeout(settleTimer);
      if (action === 'bottom') scrollToBottom({ behavior: 'instant' });
      if (id) {
        commands.scrollToMessage(messageScrollId(id), { scrollMargin: scrollMargin() });
        landed = { id, top: viewport.scrollTop };
      }
      measure();
    };
    const onScroll = () => {
      if (moving) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, 120);
      } else if (landed && Math.abs(viewport.scrollTop - landed.top) > POSITION_TOLERANCE)
        landed = undefined;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const onLayout = () => {
      // Preserve the selected answer through late Markdown/font/image layout.
      if (!moving && topLocked) commands.scrollToStart();
      if (!moving && landed) {
        if (commands.scrollToMessage(messageScrollId(landed.id), { scrollMargin: scrollMargin() }))
          landed.top = viewport.scrollTop;
        else landed = undefined;
      }
      onScroll();
    };
    schedule.current = onLayout;
    perform.current = (action) => {
      const target = targets()[action === 'previous' ? 'previous' : 'next'];
      if ((action === 'previous' || action === 'next') && !target) return;
      pauseFollowing();
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth';
      if (action === 'bottom') scrollToBottom({ behavior });
      else if (action === 'top') commands.scrollToStart({ behavior });
      else
        commands.scrollToMessage(messageScrollId(target!), {
          behavior,
          scrollMargin: scrollMargin(),
        });
      moving = { id: action === 'previous' || action === 'next' ? target : undefined, action };
      topLocked = action === 'top';
      if (behavior === 'instant') finish();
      else settleTimer = setTimeout(finish, 120);
      setAnnouncement(
        action === 'previous' || action === 'next'
          ? uiMessage('chat', 'navigationPosition', {
              position: answers.indexOf(target!) + 1,
              count: answers.length,
            })
          : uiMessage('chat', action === 'top' ? 'navigationTop' : 'navigationBottom'),
      );
      measure();
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('scrollend', finish);
    viewport.addEventListener(SCROLL_LAYOUT_EVENT, onLayout);
    viewport.addEventListener(SCROLL_INTENT_EVENT, clear);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      viewport.addEventListener(name, clear, { passive: true });
    window.addEventListener('popstate', clear);
    measure();
    return () => {
      clear();
      cancelAnimationFrame(frame);
      schedule.current = () => {};
      perform.current = () => {};
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('scrollend', finish);
      viewport.removeEventListener(SCROLL_LAYOUT_EVENT, onLayout);
      viewport.removeEventListener(SCROLL_INTENT_EVENT, clear);
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        viewport.removeEventListener(name, clear);
      window.removeEventListener('popstate', clear);
    };
  }, [conversationId, ids, answers, viewport, content, pauseFollowing, scrollToBottom, commands]);
  const navigate = useCallback((action: ReadingAction) => perform.current(action), []);
  return { ...state, announcement, navigate, refFor };
}
