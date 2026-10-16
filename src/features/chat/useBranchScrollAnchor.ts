import { useCallback, useLayoutEffect, useState } from 'react';

/** Keep the operation row stable while a replacement Markdown body finishes laying out. */
export function useBranchScrollAnchor(viewport: HTMLElement | null, content: HTMLElement | null, conversationId: string | null) {
  const [anchor, setAnchor] = useState<{ conversationId: string | null; selector: string; top: number; direction: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || anchor.conversationId !== conversationId || !viewport || !content) return;
    const row = content.querySelector<HTMLElement>(anchor.selector);
    if (!row) return;
    const restore = () => {
      if (!row.isConnected) { setAnchor(null); return; }
      viewport.scrollTop += row.getBoundingClientRect().top - anchor.top;
    };
    restore();
    const button = row.querySelector<HTMLButtonElement>(`button[data-branch-direction="${anchor.direction}"]:not(:disabled)`)
      ?? row.querySelector<HTMLButtonElement>('button:not(:disabled)');
    button?.focus({ preventScroll: true });
    const observer = new ResizeObserver(restore);
    observer.observe(content); observer.observe(viewport);
    const release = () => setAnchor(null);
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !row.contains(event.target)) release(); };
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.addEventListener(name, release, { passive: true });
    document.addEventListener('focusin', focus); window.addEventListener('popstate', release);
    return () => {
      observer.disconnect();
      for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.removeEventListener(name, release);
      document.removeEventListener('focusin', focus); window.removeEventListener('popstate', release);
    };
  }, [anchor, conversationId, viewport, content]);
  return useCallback((selector: string, top: number, direction: -1 | 1) => setAnchor({ conversationId, selector, top, direction }), [conversationId]);
}
