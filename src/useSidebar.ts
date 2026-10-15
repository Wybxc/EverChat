import { useEffect, useRef, useState } from 'react';

// The breakpoint matches the permanent sidebar in the CSS layout.
export function useSidebar(open: boolean, close: () => void) {
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 1024px)').matches);
  const sidebar = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const query = matchMedia('(min-width: 1024px)');
    const update = () => { setDesktop(query.matches); if (query.matches) closeRef.current(); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!open || desktop) return;
    const root = sidebar.current;
    if (!root) return;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]'))
      .filter((node) => !node.matches(':disabled') && node.checkVisibility());
    controls()[0]?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', trap);
    return () => window.removeEventListener('keydown', trap);
  }, [open, desktop]);
  return { sidebar, desktop, modal: open && !desktop };
}
