import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../../../shared/conversation/types';
import { uiMessage, type UiMessage } from '../../platform/i18n/messages';
import { answerTargets, POSITION_TOLERANCE, type AnswerAnchor } from './message-navigation';
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
  scrollToBottom: () => void;
}) {
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
    const live = new Set(answers);
    for (const id of callbacks.current.keys())
      if (!live.has(id)) {
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
      motionFrame = 0,
      moving: { id?: string } | undefined,
      dirty = true,
      anchors: AnswerAnchor[] = [],
      landed: { id: string; top: number } | undefined,
      topLocked = false;
    const inset = () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75;
    const clear = (event?: Event) => {
      if (event?.type === 'keydown' && !isScrollKey(event)) return;
      cancelAnimationFrame(motionFrame);
      motionFrame = 0;
      moving = undefined;
      landed = undefined;
      topLocked = false;
    };
    const readLayout = () => {
      const origin = viewport.getBoundingClientRect().top + viewport.clientTop;
      anchors = answers.flatMap((id) => {
        const element = elements.current.get(id);
        return element?.isConnected && content.contains(element)
          ? [{ id, top: viewport.scrollTop + element.getBoundingClientRect().top - origin }]
          : [];
      });
      if (!moving && topLocked) viewport.scrollTop = 0;
      if (!moving && landed) {
        const anchor = anchors.find(({ id }) => id === landed!.id);
        if (anchor) {
          viewport.scrollTop = Math.max(0, anchor.top - inset());
          landed.top = viewport.scrollTop;
        } else clear();
      }
      dirty = false;
    };
    const targets = () =>
      answerTargets(
        anchors,
        viewport.scrollTop + inset(),
        moving?.id ??
          (landed && Math.abs(landed.top - viewport.scrollTop) <= POSITION_TOLERANCE
            ? landed.id
            : undefined),
      );
    const measure = () => {
      if (dirty) readLayout();
      // The normal top/end padding is symmetric; only the toolbar adds extra end space.
      // Read resolved lengths: a custom property may still contain rem or calc().
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
        old.visible === next.visible &&
        old.vertical === next.vertical &&
        old.atTop === next.atTop &&
        old.atBottom === next.atBottom &&
        old.previous === next.previous &&
        old.next === next.next
          ? old
          : next,
      );
    };
    const request = (layout = false) => {
      dirty ||= layout;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const onScroll = () => {
      if (!moving && landed && Math.abs(viewport.scrollTop - landed.top) > POSITION_TOLERANCE)
        clear();
      request();
    };
    const onLayout = () => request(true);
    schedule.current = onLayout;
    const move = (action: ReadingAction, id?: string) => {
      pauseFollowing();
      moving = { id };
      const from = viewport.scrollTop;
      const destination = () => {
        const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const position =
          action === 'bottom'
            ? maximum
            : id
              ? (anchors.find((anchor) => anchor.id === id)?.top ?? from + inset()) - inset()
              : 0;
        return Math.min(maximum, Math.max(0, position));
      };
      const duration = Math.min(420, Math.max(180, Math.abs(destination() - from) * 0.2));
      const started = performance.now();
      const finish = () => {
        viewport.scrollTop = destination();
        moving = undefined;
        motionFrame = 0;
        if (id) landed = { id, top: viewport.scrollTop };
        else if (action === 'top') topLocked = true;
        else scrollToBottom();
        measure();
      };
      const step = (now: number) => {
        if (dirty) readLayout();
        const progress = Math.min(1, (now - started) / duration);
        if (progress >= 1) finish();
        else {
          // Re-read the destination as streamed Markdown changes the content height.
          viewport.scrollTop = from + (destination() - from) * (1 - (1 - progress) ** 3);
          motionFrame = requestAnimationFrame(step);
        }
      };
      if (
        matchMedia('(prefers-reduced-motion: reduce)').matches ||
        Math.abs(destination() - from) <= POSITION_TOLERANCE
      )
        finish();
      else motionFrame = requestAnimationFrame(step);
    };
    perform.current = (action) => {
      // Read fresh geometry for a click even if a layout observer has not delivered yet.
      readLayout();
      const target = targets()[action === 'previous' ? 'previous' : 'next'];
      if (action === 'previous' || action === 'next') {
        const anchor = anchors.find(({ id }) => id === target);
        if (!anchor) return;
        move(action, anchor.id);
        setAnnouncement(
          uiMessage('chat', 'navigationPosition', {
            position: answers.indexOf(anchor.id) + 1,
            count: answers.length,
          }),
        );
      } else if (action === 'top') {
        move(action);
        setAnnouncement(uiMessage('chat', 'navigationTop'));
      } else {
        move(action);
        setAnnouncement(uiMessage('chat', 'navigationBottom'));
      }
      measure();
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener(SCROLL_LAYOUT_EVENT, onLayout);
    viewport.addEventListener(SCROLL_INTENT_EVENT, clear);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      viewport.addEventListener(name, clear, { passive: true });
    window.addEventListener('popstate', clear);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(motionFrame);
      schedule.current = () => {};
      perform.current = () => {};
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener(SCROLL_LAYOUT_EVENT, onLayout);
      viewport.removeEventListener(SCROLL_INTENT_EVENT, clear);
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        viewport.removeEventListener(name, clear);
      window.removeEventListener('popstate', clear);
    };
  }, [conversationId, ids, answers, viewport, content, pauseFollowing, scrollToBottom]);

  const navigate = useCallback((action: ReadingAction) => perform.current(action), []);
  return { ...state, announcement, navigate, refFor };
}
