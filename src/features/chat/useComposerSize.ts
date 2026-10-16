import { useEffect,type RefObject } from 'react';

export function useComposerSize(editor: RefObject<HTMLTextAreaElement | null>, draft: string) {
  useEffect(() => {
    const node = editor.current;
    if (!node) return;
    const resize = () => { node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; };
    resize();
    // Font preferences and wrapping can change without changing the draft.
    const metrics = () => { const style = getComputedStyle(node); return `${node.clientWidth}:${style.fontSize}:${style.lineHeight}:${style.paddingBlock}`; };
    let previous = metrics();
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); };
    const observer = new ResizeObserver(() => {
      const next = metrics();
      if (next !== previous) { previous = next; schedule(); }
    });
    observer.observe(node);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
  }, [editor, draft]);
}
