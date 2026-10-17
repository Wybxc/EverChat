import { useCallback, useEffect, useRef, useState } from 'react';
import { isScrollKey, SCROLL_INTENT_EVENT } from './scroll-intent';

const HIDE_DELAY = 2000;
const INTERACTIVE =
  'a, button, input, textarea, select, summary, [role="button"], [contenteditable="true"]';

/** Reveal for reading intent, not for streaming or other programmatic scrolls. */
export function useNavigationVisibility(viewport: HTMLElement | null, enabled: boolean) {
  const [active, setActive] = useState(false);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback(() => {
    clearTimeout(timer.current);
    setActive(true);
    if (!hovered.current) timer.current = setTimeout(() => setActive(false), HIDE_DELAY);
  }, []);

  useEffect(() => {
    setActive(false);
    hovered.current = false;
    if (!enabled || !viewport) return;
    let manualUntil = 0;
    let previousTop = viewport.scrollTop;
    const programmatic = () => {
      manualUntil = 0;
    };
    const intent = (event: Event) => {
      if (
        event.type === 'keydown' &&
        (!isScrollKey(event) ||
          (event.target instanceof Element && event.target.closest(INTERACTIVE)))
      )
        return;
      manualUntil = performance.now() + 300;
    };
    const scroll = () => {
      const moved = previousTop !== viewport.scrollTop;
      previousTop = viewport.scrollTop;
      // Following stream chunks at the bottom must not extend a recent manual scroll forever.
      if (
        !moved ||
        performance.now() > manualUntil ||
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2
      )
        return;
      manualUntil = performance.now() + 300;
      show();
    };
    const tap = (event: PointerEvent) => {
      if (
        event.pointerType !== 'touch' ||
        !event.isPrimary ||
        !(event.target instanceof Element) ||
        event.target.closest(`${INTERACTIVE}, pre, code`) ||
        !document.getSelection()?.isCollapsed
      )
        return;
      show();
    };
    for (const name of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
      viewport.addEventListener(name, intent, { passive: true });
    viewport.addEventListener('scroll', scroll, { passive: true });
    viewport.addEventListener('pointerup', tap, { passive: true });
    viewport.addEventListener(SCROLL_INTENT_EVENT, programmatic);
    return () => {
      clearTimeout(timer.current);
      for (const name of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
        viewport.removeEventListener(name, intent);
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('pointerup', tap);
      viewport.removeEventListener(SCROLL_INTENT_EVENT, programmatic);
    };
  }, [viewport, enabled, show]);

  return {
    active,
    show,
    enter: () => {
      // WebKit can synthesize mouse entry after a touch even without hover support.
      if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      hovered.current = true;
      show();
    },
    leave: () => {
      if (!hovered.current) return;
      hovered.current = false;
      show();
    },
  };
}
