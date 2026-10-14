import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 24;
export const PAUSE_FOLLOW_EVENT = 'everchat:pause-follow';

export function useFollowScroll(resetKey?: string | null) {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const previousTop = useRef(0);

  const scrollToBottom = useCallback(() => {
    following.current = true;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      previousTop.current = viewport.scrollTop;
    }
    setAtBottom(true);
  }, [viewport]);

  useLayoutEffect(() => {
    if (!viewport || !content) return;
    scrollToBottom();
    const distance = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    let previousBottom = viewport.scrollHeight - viewport.clientHeight;
    // A chunk can grow the content between reaching the old bottom and delivery of its scroll event.
    const reachedPreviousBottom = () => viewport.scrollTop > previousTop.current && Math.abs(viewport.scrollTop - previousBottom) <= BOTTOM_THRESHOLD;
    const onScroll = () => {
      const bottom = distance() <= BOTTOM_THRESHOLD;
      if (bottom || reachedPreviousBottom()) following.current = true;
      // Content growth can also emit a scroll event. Only upward movement pauses following.
      else if (viewport.scrollTop < previousTop.current) following.current = false;
      previousTop.current = viewport.scrollTop;
      previousBottom = viewport.scrollHeight - viewport.clientHeight;
      if (following.current && !bottom) scrollToBottom();
      else setAtBottom(bottom);
    };
    const onResize = () => {
      if (distance() <= BOTTOM_THRESHOLD || reachedPreviousBottom()) following.current = true;
      previousBottom = viewport.scrollHeight - viewport.clientHeight;
      if (following.current) scrollToBottom();
    };
    const observer = new ResizeObserver(onResize);
    const pause = () => { following.current = false; };
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener(PAUSE_FOLLOW_EVENT, pause);
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', onScroll); viewport.removeEventListener(PAUSE_FOLLOW_EVENT, pause); };
  }, [viewport, content, resetKey, scrollToBottom]);

  return { viewportRef, contentRef, viewport, content, atBottom, scrollToBottom };
}
