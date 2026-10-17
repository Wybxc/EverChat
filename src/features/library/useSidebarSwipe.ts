import { useEffect, useRef, useState } from 'react';
import { hasOpenModal } from '../../components/Modal';
import { pwaSnapshot } from '../../platform/pwa/controller';

const interactive =
  'input, textarea, select, button, a, [contenteditable="true"], [role="menu"], [role="slider"], pre, table, .katex-display';
type Gesture = {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  width: number;
  opening: boolean;
  locked: boolean;
  target: Element;
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
      const previous = gesture;
      gesture = undefined;
      if (previous?.target.hasPointerCapture?.(previous.id))
        previous.target.releasePointerCapture(previous.id);
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
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !event.isPrimary || settling || gesture) {
        if (gesture && event.pointerType === 'touch') clear();
        return;
      }
      if (blocked() || !(event.target instanceof Element) || event.target.closest(interactive))
        return;
      const panel = event.target.closest('[data-sidebar-panel]');
      const opening = !current.current.open;
      const safeLeft =
        parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-swipe-inset')) || 0;
      if (opening ? event.clientX < safeLeft + 16 || event.clientX > safeLeft + 40 : !panel) return;
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
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastTime: event.timeStamp,
        velocity: 0,
        width,
        opening,
        locked: false,
        target: event.target,
      };
    };
    const move = (event: PointerEvent) => {
      const g = gesture;
      if (!g || g.id !== event.pointerId || settling) return;
      if (g.locked && blocked()) {
        clear();
        return;
      }
      const dx = event.clientX - g.x,
        dy = event.clientY - g.y;
      if (!g.locked) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
        if (blocked() || Math.abs(dx) <= Math.abs(dy) * 1.5 || (g.opening ? dx < 0 : dx > 0)) {
          clear();
          return;
        }
        g.locked = true;
        g.target.setPointerCapture?.(g.id);
        setDragging(true);
        setPreview(g.opening);
        root.dataset.sidebarDrag = 'dragging';
      }
      event.preventDefault();
      if (event.timeStamp > g.lastTime)
        g.velocity = (event.clientX - g.lastX) / (event.timeStamp - g.lastTime);
      g.lastTime = event.timeStamp;
      g.lastX = event.clientX;
      paint(Math.max(-g.width, Math.min(0, (g.opening ? -g.width : 0) + dx)), g.width);
    };
    const finish = (event: PointerEvent) => {
      const g = gesture;
      if (!g || g.id !== event.pointerId || settling) return;
      if (!g.locked) {
        clear();
        return;
      }
      suppressClick = { x: event.clientX, y: event.clientY, until: performance.now() + 100 };
      settling = true;
      const distance = (event.clientX - g.x) * (g.opening ? 1 : -1);
      const recentVelocity =
        event.timeStamp - g.lastTime < 100 ? g.velocity * (g.opening ? 1 : -1) : 0;
      const commit =
        event.type === 'pointerup' &&
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
    const cancel = (event: PointerEvent) => {
      if (gesture?.id === event.pointerId) finish(event);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', cancel, true);
    document.addEventListener('lostpointercapture', cancel, true);
    document.addEventListener('click', click, true);
    window.addEventListener('resize', clear);
    return () => {
      clear();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('lostpointercapture', cancel, true);
      document.removeEventListener('click', click, true);
      window.removeEventListener('resize', clear);
    };
  }, [desktop]);
  return { preview, dragging };
}
