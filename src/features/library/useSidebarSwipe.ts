import { useEffect, useRef, useState } from 'react';
import { hasOpenModal } from '../../components/Modal';
import { pwaSnapshot } from '../../platform/pwa/controller';

const interactive =
  'input, textarea, select, button, [contenteditable="true"], [role="menu"], [role="slider"], pre, table, .katex-display';
type Gesture = {
  id: number;
  x: number;
  y: number;
  lastTime: number;
  velocity: number;
  samples: { x: number; time: number }[];
  width: number;
  opening: boolean;
  locked: boolean;
};

/** Only gesture boundaries enter React state; progress is painted once per frame. */
export function useSidebarSwipe(desktop: boolean, open: boolean, change: (open: boolean) => void) {
  const [preview, setPreview] = useState(false);
  const [dragging, setDragging] = useState(false);
  const current = useRef({ open, change });
  current.current = { open, change };
  useEffect(() => {
    if (desktop) return;
    let gesture: Gesture | undefined,
      frame = 0,
      finishTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressClick: { x: number; y: number; until: number } | undefined,
      settling = false;
    const root = document.documentElement;
    const paint = (x: number, width: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--sidebar-drag-x', `${x}px`);
        root.style.setProperty('--sidebar-drag-opacity', String(1 + x / width));
      });
    };
    const clear = () => {
      cancelAnimationFrame(frame);
      clearTimeout(finishTimer);
      gesture = undefined;
      settling = false;
      setPreview(false);
      setDragging(false);
      root.removeAttribute('data-sidebar-drag');
      root.style.removeProperty('--sidebar-drag-x');
      root.style.removeProperty('--sidebar-drag-opacity');
    };
    const blocked = () =>
      hasOpenModal() ||
      pwaSnapshot().preparing ||
      Boolean(document.querySelector('[role="menu"][data-state="open"]')) ||
      Boolean(window.getSelection()?.toString());
    const down = (event: TouchEvent) => {
      if (event.touches.length !== 1 || settling || gesture) {
        if (gesture) clear();
        return;
      }
      if (blocked() || !(event.target instanceof Element) || event.target.closest(interactive))
        return;
      const panel = event.target.closest('[data-sidebar-panel]');
      const opening = !current.current.open;
      if (opening && event.target.closest('a')) return;
      const safeLeft =
        parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-swipe-inset')) || 0;
      const point = event.touches[0]!;
      // Start inside the page instead of competing with browser edge navigation.
      // This is an app gesture boundary, not an estimate of iOS's reserved width.
      if (opening ? point.clientX < safeLeft + 64 || point.clientX > safeLeft + 112 : !panel)
        return;
      // Horizontal scrollers keep their own gesture even when their content is not code.
      for (
        let node: Element | null = event.target;
        node && node !== panel && node !== document.body;
        node = node.parentElement
      ) {
        if (
          node.scrollWidth > node.clientWidth + 1 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const width =
        panel?.getBoundingClientRect().width ??
        Math.min((320 * parseFloat(getComputedStyle(root).fontSize)) / 16, innerWidth - 16);
      gesture = {
        id: point.identifier,
        x: point.clientX,
        y: point.clientY,
        lastTime: event.timeStamp,
        velocity: 0,
        samples: [{ x: point.clientX, time: event.timeStamp }],
        width,
        opening,
        locked: false,
      };
    };
    const move = (event: TouchEvent) => {
      const g = gesture;
      if (!g || settling) return;
      const point = event.touches[0];
      if (event.touches.length !== 1 || !point || point.identifier !== g.id) {
        clear();
        return;
      }
      if (g.locked && blocked()) {
        clear();
        return;
      }
      const dx = point.clientX - g.x,
        dy = point.clientY - g.y;
      if (!g.locked) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
        if (blocked() || Math.abs(dx) <= Math.abs(dy) * 1.5 || (g.opening ? dx < 0 : dx > 0)) {
          clear();
          return;
        }
        g.locked = true;
        setDragging(true);
        setPreview(g.opening);
        root.dataset.sidebarDrag = 'dragging';
      }
      // Preserve native scrolling and selection until the horizontal drag locks.
      if (event.cancelable) event.preventDefault();
      if (event.timeStamp > g.lastTime) {
        g.samples.push({ x: point.clientX, time: event.timeStamp });
        // Keep a short trajectory rather than trusting one coalesced or delayed event.
        while (g.samples.length > 2 && event.timeStamp - g.samples[0]!.time > 120)
          g.samples.shift();
        const first = g.samples[0]!;
        g.velocity = (point.clientX - first.x) / (event.timeStamp - first.time);
      }
      g.lastTime = event.timeStamp;
      paint(Math.max(-g.width, Math.min(0, (g.opening ? -g.width : 0) + dx)), g.width);
    };
    const finish = (event: TouchEvent) => {
      const g = gesture;
      if (!g || settling) return;
      const point = Array.from(event.changedTouches).find(({ identifier }) => identifier === g.id);
      if (!g.locked || !point) {
        clear();
        return;
      }
      suppressClick = { x: point.clientX, y: point.clientY, until: performance.now() + 100 };
      settling = true;
      const distance = (point.clientX - g.x) * (g.opening ? 1 : -1);
      const recentVelocity =
        event.timeStamp - g.lastTime < 100 ? g.velocity * (g.opening ? 1 : -1) : 0;
      const commit =
        event.type === 'touchend' &&
        (distance >= g.width * 0.25 || (distance >= 40 && recentVelocity >= 0.5));
      const next = commit ? g.opening : !g.opening;
      root.dataset.sidebarDrag = 'settling';
      paint(next ? 0 : -g.width, g.width);
      finishTimer = setTimeout(
        () => {
          current.current.change(next);
          clear();
        },
        matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
      );
    };
    const click = (event: MouseEvent) => {
      const end = suppressClick;
      suppressClick = undefined;
      if (
        !end ||
        performance.now() > end.until ||
        event.detail === 0 ||
        Math.hypot(event.clientX - end.x, event.clientY - end.y) > 5
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    // Keep a single touch stream: native scrolling may cancel pointer events
    // while touch events continue. A late listener cannot reliably reclaim it.
    document.addEventListener('touchstart', down, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: false });
    document.addEventListener('touchend', finish, { capture: true, passive: true });
    document.addEventListener('touchcancel', finish, { capture: true, passive: true });
    document.addEventListener('click', click, true);
    // A browser navigation must never leave a delayed sidebar commit behind.
    window.addEventListener('popstate', clear);
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', clear);
    return () => {
      clear();
      document.removeEventListener('touchstart', down, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', finish, true);
      document.removeEventListener('touchcancel', finish, true);
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', clear);
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', clear);
    };
  }, [desktop]);
  return { preview, dragging };
}
