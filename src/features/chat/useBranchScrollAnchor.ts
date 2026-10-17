import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isScrollKey, SCROLL_INTENT_EVENT, SCROLL_LAYOUT_EVENT } from './scroll-intent';

/** Keep the operation row stable while a replacement Markdown body finishes laying out. */
export function useBranchScrollAnchor(
  viewport: HTMLElement | null,
  content: HTMLElement | null,
  conversationId: string | null,
) {
  const version = useRef(0);
  const [anchor, setAnchor] = useState<{
    conversationId: string | null;
    selector: string;
    top: number;
    direction: -1 | 1;
    version: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!content || !viewport) return;
    const clear = () => content.style.removeProperty('--branch-anchor-space');
    viewport.addEventListener(SCROLL_INTENT_EVENT, clear);
    return () => {
      viewport.removeEventListener(SCROLL_INTENT_EVENT, clear);
      clear();
    };
  }, [content, viewport, conversationId]);
  useLayoutEffect(() => {
    if (!anchor || anchor.conversationId !== conversationId || !viewport || !content) return;
    const row = content.querySelector<HTMLElement>(anchor.selector);
    if (!row) return;
    let endSpace = parseFloat(content.style.getPropertyValue('--branch-anchor-space')) || 0;
    const restore = () => {
      if (anchor.version !== version.current) return;
      if (!row.isConnected) {
        setAnchor(null);
        return;
      }
      const target = viewport.scrollTop + row.getBoundingClientRect().top - anchor.top;
      // Compact descendants may leave too little content below the operation
      // row to reach its old position. Reserve only the missing scroll range.
      const missing = Math.ceil(target - (viewport.scrollHeight - viewport.clientHeight));
      if (missing > 0) {
        endSpace += missing;
        content.style.setProperty('--branch-anchor-space', `${endSpace}px`);
      }
      viewport.scrollTop = target;
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
      // Keep the reserved range when a pointer press releases the anchor;
      // collapsing it here can move a button between pointerdown and click.
    };
  }, [anchor, conversationId, viewport, content]);
  return useCallback(
    (selector: string, top: number, direction: -1 | 1) =>
      setAnchor({ conversationId, selector, top, direction, version: ++version.current }),
    [conversationId],
  );
}
