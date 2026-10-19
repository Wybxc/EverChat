import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isScrollKey, SCROLL_INTENT_EVENT, SCROLL_LAYOUT_EVENT } from './scroll-intent';

const BOTTOM_THRESHOLD = 24;
export const PAUSE_FOLLOW_EVENT = 'everchat:pause-follow';

export function useFollowScroll(resetKey?: string | null) {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const paused = useRef(false);
  const previousTop = useRef(0);

  const followBottom = useCallback(() => {
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      previousTop.current = viewport.scrollTop;
    }
    setAtBottom(true);
  }, [viewport]);
  const scrollToBottom = useCallback(() => {
    viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
    paused.current = false;
    following.current = true;
    followBottom();
  }, [viewport, followBottom]);
  const pauseFollowing = useCallback(() => {
    viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
    paused.current = true;
    following.current = false;
  }, [viewport]);

  useLayoutEffect(() => {
    if (!viewport || !content) return;
    scrollToBottom();
    const distance = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    let previousBottom = viewport.scrollHeight - viewport.clientHeight;
    // A chunk can grow the content between reaching the old bottom and delivery of its scroll event.
    const reachedPreviousBottom = () =>
      viewport.scrollTop > previousTop.current &&
      Math.abs(viewport.scrollTop - previousBottom) <= BOTTOM_THRESHOLD;
    const onScroll = () => {
      const bottom = distance() <= BOTTOM_THRESHOLD;
      const currentBottom = viewport.scrollHeight - viewport.clientHeight;
      if (!paused.current && (bottom || reachedPreviousBottom())) following.current = true;
      // WebKit can anchor upward while lazy content changes height, before ResizeObserver fires.
      // An unchanged scroll range distinguishes ordinary upward scrolling from that reflow.
      else if (viewport.scrollTop < previousTop.current && currentBottom === previousBottom)
        following.current = false;
      previousTop.current = viewport.scrollTop;
      previousBottom = currentBottom;
      if (following.current && !bottom) followBottom();
      else setAtBottom(bottom);
    };
    const onResize = () => {
      if (!paused.current && (distance() <= BOTTOM_THRESHOLD || reachedPreviousBottom()))
        following.current = true;
      previousBottom = viewport.scrollHeight - viewport.clientHeight;
      if (following.current) followBottom();
      viewport.dispatchEvent(new Event(SCROLL_LAYOUT_EVENT));
    };
    const observer = new ResizeObserver(onResize);
    const resumeIntent = (event: Event) => {
      if (isScrollKey(event)) paused.current = false;
    };
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      viewport.addEventListener(name, resumeIntent, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        viewport.removeEventListener(name, resumeIntent);
    };
  }, [viewport, content, resetKey, scrollToBottom, followBottom, pauseFollowing]);

  return { viewportRef, contentRef, viewport, content, atBottom, scrollToBottom, pauseFollowing };
}
