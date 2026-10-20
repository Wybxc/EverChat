import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { MessageScrollerProvider, useMessageScroller } from '@/components/ui/message-scroller';
import {
  isScrollKey,
  PAUSE_FOLLOW_EVENT,
  SCROLL_INTENT_EVENT,
  SCROLL_LAYOUT_EVENT,
} from './scroll-intent';

export const messageScrollId = (id: string) => `message:${id}`;

const FollowingContext = createContext<{
  set: (enabled: boolean) => void;
  enabled: { current: boolean };
}>({ set: () => {}, enabled: { current: true } });

/** Each transcript/reasoning pane owns an independent scroller and following mode. */
export function ChatScrollProvider({ children }: PropsWithChildren) {
  const [following, setState] = useState(true);
  const enabled = useRef(true);
  const setFollowing = useCallback((value: boolean) => {
    enabled.current = value;
    setState(value);
  }, []);
  const intent = useMemo(() => ({ set: setFollowing, enabled }), [setFollowing]);
  return (
    <FollowingContext value={intent}>
      <MessageScrollerProvider
        autoScroll={following}
        defaultScrollPosition="end"
        scrollEdgeThreshold={24}
      >
        {children}
      </MessageScrollerProvider>
    </FollowingContext>
  );
}

/** Business intent/focus bridge. The library owns bottom-follow and scroll range/spacers. */
export function useChatScroll(resetKey?: string | null) {
  const commands = useMessageScroller();
  const { set: setFollowing, enabled } = useContext(FollowingContext);
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const endFrame = useRef(0);
  const locked = useRef(false);
  const scheduleEnd = useCallback(
    (options?: { behavior?: ScrollBehavior }) => {
      cancelAnimationFrame(endFrame.current);
      endFrame.current = requestAnimationFrame(() => {
        endFrame.current = 0;
        if (enabled.current && !locked.current) commands.scrollToEnd(options);
      });
    },
    [commands, enabled],
  );
  const pauseFollowing = useCallback(() => {
    locked.current = true;
    cancelAnimationFrame(endFrame.current);
    setFollowing(false);
    viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
  }, [setFollowing, viewport]);
  const scrollToBottom = useCallback(
    (options?: { behavior?: ScrollBehavior }) => {
      locked.current = false;
      cancelAnimationFrame(endFrame.current);
      setFollowing(true);
      viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
      // Commit autoScroll before the library decides whether this command resumes following.
      scheduleEnd(options);
    },
    [scheduleEnd, setFollowing, viewport],
  );

  useLayoutEffect(() => {
    if (!viewport || !content) return;
    scrollToBottom();
    const resume = (event: Event) => {
      if (event.type === 'keydown' && !isScrollKey(event)) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[data-slot="message-scroller-viewport"]') !== viewport
      )
        return;
      // Horizontal or zero-delta wheel events can interrupt navigation without
      // expressing intent to resume following at the nearby live edge.
      if (event instanceof WheelEvent && event.deltaY === 0) return;
      cancelAnimationFrame(endFrame.current);
      locked.current = false;
      const downward =
        event instanceof WheelEvent
          ? event.deltaY > 0
          : event instanceof KeyboardEvent &&
            ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
      // A wheel at the end may produce no scroll event. Resume after the library
      // has processed intent, so the next delayed chunk still follows.
      if (downward && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24) {
        setFollowing(true);
        scheduleEnd();
      } else setFollowing(false);
    };
    // Forward geometry changes to business anchors and repair a return to the
    // old bottom in the same frame as a new chunk grows the range.
    let previousTop = viewport.scrollTop;
    let previousBottom = viewport.scrollHeight - viewport.clientHeight;
    const syncReadingIntent = () => {
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      const top = viewport.scrollTop;
      const atEnd = maximum - top <= 24;
      const returnedToOldEnd =
        maximum > previousBottom && top > previousTop && Math.abs(top - previousBottom) <= 24;
      // The library ignores upward scrolls during its 180ms auto-scroll window.
      // Preserve a small reflow adjustment, but yield to a reader moving away
      // even if a chunk grows the range before its scroll event is delivered.
      const movedUp =
        top < previousTop &&
        (maximum === previousBottom || top < Math.min(previousTop, maximum) - 24);
      if (movedUp && !atEnd) {
        // A queued return to the live edge must yield before its next frame,
        // even when autoScroll=false has not committed to the primitive yet.
        cancelAnimationFrame(endFrame.current);
        setFollowing(false);
      } else if (
        !locked.current &&
        (atEnd || returnedToOldEnd) &&
        (!enabled.current || returnedToOldEnd)
      ) {
        setFollowing(true);
        scheduleEnd();
      }
      previousTop = top;
      previousBottom = maximum;
    };
    const pauseForSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || locked.current) return;
      for (let index = 0; index < selection.rangeCount; index++)
        if (selection.getRangeAt(index).intersectsNode(content)) {
          pauseFollowing();
          break;
        }
    };
    const layout = new ResizeObserver(() => {
      const resized = viewport.scrollHeight - viewport.clientHeight !== previousBottom;
      syncReadingIntent();
      // Markdown reflow can make the primitive leave following mode before its
      // resize callback. Restore the explicit reading intent through its command.
      // Let native scroll intent run before repairing layout. Writing from this
      // resize callback can overwrite a reader's scroll before its event arrives.
      if (resized && enabled.current && !locked.current) scheduleEnd();
      viewport.dispatchEvent(new Event(SCROLL_LAYOUT_EVENT));
    });
    layout.observe(content);
    layout.observe(viewport);
    viewport.addEventListener('scroll', syncReadingIntent, { passive: true });
    viewport.addEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
    document.addEventListener('selectionchange', pauseForSelection);
    for (const name of ['wheel', 'touchmove', 'keydown'])
      viewport.addEventListener(name, resume, { passive: true });
    return () => {
      cancelAnimationFrame(endFrame.current);
      layout.disconnect();
      viewport.removeEventListener('scroll', syncReadingIntent);
      viewport.removeEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
      document.removeEventListener('selectionchange', pauseForSelection);
      for (const name of ['wheel', 'touchmove', 'keydown'])
        viewport.removeEventListener(name, resume);
    };
  }, [
    viewport,
    content,
    resetKey,
    pauseFollowing,
    scrollToBottom,
    setFollowing,
    enabled,
    scheduleEnd,
  ]);

  return {
    viewport,
    viewportRef,
    content,
    contentRef,
    pauseFollowing,
    scrollToBottom,
  };
}
