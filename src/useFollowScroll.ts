import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 24;

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
    const onScroll = () => {
      const bottom = distance() <= BOTTOM_THRESHOLD;
      if (bottom) following.current = true;
      // Content growth can also emit a scroll event. Only upward movement pauses following.
      else if (viewport.scrollTop < previousTop.current) following.current = false;
      previousTop.current = viewport.scrollTop;
      setAtBottom(bottom);
    };
    const onResize = () => {
      if (following.current) scrollToBottom();
      else if (distance() <= BOTTOM_THRESHOLD) {
        following.current = true;
        setAtBottom(true);
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', onScroll); };
  }, [viewport, content, resetKey, scrollToBottom]);

  return { viewportRef, contentRef, atBottom, scrollToBottom };
}
