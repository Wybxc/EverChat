import { useLayoutEffect, useState } from 'react';

/** Measure the composer itself: sidebars and font preferences also consume its space. */
export function useComposerLayout() {
  const [toolbar, toolbarRef] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(true);
  useLayoutEffect(() => {
    if (!toolbar) return;
    const measure = () => {
      const fontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setCompact(toolbar.clientWidth < 40 * fontSize);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [toolbar]);
  return { toolbarRef, compact };
}
