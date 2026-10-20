import { useMessageScroller } from '@/components/ui/message-scroller';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isScrollKey, SCROLL_INTENT_EVENT, SCROLL_LAYOUT_EVENT } from './scroll-intent';

/** Keep the operation row stable while a replacement Markdown body finishes laying out. */
export function useBranchScrollAnchor(
  viewport: HTMLElement | null,
  content: HTMLElement | null,
  conversationId: string | null,
) {
  const { scrollToMessage } = useMessageScroller();
  const version = useRef(0);
  const [anchor, setAnchor] = useState<{
    conversationId: string | null;
    selector: string;
    top: number;
    direction: -1 | 1;
    version: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || anchor.conversationId !== conversationId || !viewport || !content) return;
    const row = content.querySelector<HTMLElement>(anchor.selector);
    if (!row) return;
    const restore = () => {
      if (anchor.version !== version.current) return;
      if (!row.isConnected) {
        setAnchor(null);
        return;
      }
      const item = row.closest<HTMLElement>('[data-scroll-id]');
      if (!item?.dataset.scrollId) return;
      const offset = row.getBoundingClientRect().top - item.getBoundingClientRect().top;
      scrollToMessage(item.dataset.scrollId, {
        scrollMargin:
          anchor.top -
          viewport.getBoundingClientRect().top -
          offset -
          parseFloat(getComputedStyle(content).paddingTop),
      });
    };
    restore();
    const button =
      row.querySelector<HTMLButtonElement>(
        `button[data-branch-direction="${anchor.direction}"]:not(:disabled)`,
      ) ?? row.querySelector<HTMLButtonElement>('button:not(:disabled)');
    button?.focus({ preventScroll: true });
    const release = (event?: Event) => {
      if (event?.type === 'keydown' && !isScrollKey(event)) return;
      version.current++;
      setAnchor(null);
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !row.contains(event.target)) release();
    };
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      viewport.addEventListener(name, release, { passive: true });
    document.addEventListener('focusin', focus);
    window.addEventListener('popstate', release);
    viewport.addEventListener(SCROLL_INTENT_EVENT, release);
    viewport.addEventListener(SCROLL_LAYOUT_EVENT, restore);
    return () => {
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        viewport.removeEventListener(name, release);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('popstate', release);
      viewport.removeEventListener(SCROLL_INTENT_EVENT, release);
      viewport.removeEventListener(SCROLL_LAYOUT_EVENT, restore);
    };
  }, [anchor, conversationId, viewport, content, scrollToMessage]);
  return useCallback(
    (selector: string, top: number, direction: -1 | 1) =>
      setAnchor({ conversationId, selector, top, direction, version: ++version.current }),
    [conversationId],
  );
}
