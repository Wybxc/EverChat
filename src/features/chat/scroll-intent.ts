/** Local to each scroll viewport, including nested reasoning panes. */
export const SCROLL_INTENT_EVENT = 'everchat:scroll-intent';
export const SCROLL_LAYOUT_EVENT = 'everchat:scroll-layout';

export function isScrollKey(event: Event) {
  return (
    !(event instanceof KeyboardEvent) ||
    ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'End', 'Home', ' '].includes(event.key)
  );
}
