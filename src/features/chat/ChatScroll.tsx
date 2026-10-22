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

const SCROLL_EDGE_THRESHOLD = 24;
// Reading resumes at the end; selection/navigation pauses wait for fresh user intent.
type FollowMode = 'following' | 'reading' | 'paused';

const FollowingContext = createContext<{
  set: (mode: FollowMode) => void;
  mode: { current: FollowMode };
}>({ set: () => {}, mode: { current: 'following' } });

/** Each transcript/reasoning pane owns an independent scroller and following mode. */
export function ChatScrollProvider({ children }: PropsWithChildren) {
  const [following, setState] = useState(true);
  const mode = useRef<FollowMode>('following');
  const setMode = useCallback((value: FollowMode) => {
    mode.current = value;
    setState(value === 'following');
  }, []);
  const intent = useMemo(() => ({ set: setMode, mode }), [setMode]);
  return (
    <FollowingContext value={intent}>
      <MessageScrollerProvider
        autoScroll={following}
        defaultScrollPosition="end"
        scrollEdgeThreshold={SCROLL_EDGE_THRESHOLD}
      >
        {children}
      </MessageScrollerProvider>
    </FollowingContext>
  );
}

/** Business intent/focus bridge. The library owns bottom-follow and scroll range/spacers. */
export function useChatScroll(resetKey?: string | null) {
  const commands = useMessageScroller();
  const { set: setMode, mode } = useContext(FollowingContext);
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const endFrame = useRef(0);
  const scheduleEnd = useCallback(
    (options?: { behavior?: ScrollBehavior }) => {
      cancelAnimationFrame(endFrame.current);
      endFrame.current = requestAnimationFrame(() => {
        endFrame.current = 0;
        if (mode.current === 'following') commands.scrollToEnd(options);
      });
    },
    [commands, mode],
  );
  const pauseFollowing = useCallback(() => {
    cancelAnimationFrame(endFrame.current);
    setMode('paused');
    viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
  }, [setMode, viewport]);
  const scrollToBottom = useCallback(
    (options?: { behavior?: ScrollBehavior }) => {
      setMode('following');
      viewport?.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
      // Commit autoScroll before the library decides whether this command resumes following.
      scheduleEnd(options);
    },
    [scheduleEnd, setMode, viewport],
  );

  useLayoutEffect(() => {
    if (!viewport || !content) return;
    scrollToBottom();
    const read = (event: Event) => {
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
      const downward =
        event instanceof WheelEvent
          ? event.deltaY > 0
          : event instanceof KeyboardEvent &&
            ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
      const atEnd =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= SCROLL_EDGE_THRESHOLD;
      setMode(downward && atEnd ? 'following' : 'reading');
      // A downward wheel at the end may produce no scroll event.
      if (mode.current === 'following') scheduleEnd();
    };
    let previousTop = viewport.scrollTop;
    let previousBottom = viewport.scrollHeight - viewport.clientHeight;
    const syncReadingIntent = () => {
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      const top = viewport.scrollTop;
      if (mode.current !== 'paused') {
        // Native input already pauses immediately; geometry alone can be a small reflow.
        if (
          top < previousTop &&
          maximum - top > SCROLL_EDGE_THRESHOLD &&
          (maximum === previousBottom ||
            top < Math.min(previousTop, maximum) - SCROLL_EDGE_THRESHOLD)
        ) {
          cancelAnimationFrame(endFrame.current);
          setMode('reading');
        } else if (
          mode.current === 'reading' &&
          top > previousTop &&
          (maximum - top <= SCROLL_EDGE_THRESHOLD ||
            Math.abs(previousBottom - top) <= SCROLL_EDGE_THRESHOLD)
        ) {
          // Only downward movement resumes following. Include the old end when
          // a new chunk grows the range before the scroll event is delivered.
          setMode('following');
          scheduleEnd();
        }
      }
      previousTop = top;
      previousBottom = maximum;
    };
    const pauseForSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || mode.current === 'paused') return;
      for (let index = 0; index < selection.rangeCount; index++)
        if (selection.getRangeAt(index).intersectsNode(content)) {
          pauseFollowing();
          break;
        }
    };
    const layout = new ResizeObserver(() => {
      const resized = viewport.scrollHeight - viewport.clientHeight !== previousBottom;
      syncReadingIntent();
      // Keep Markdown reflow following deferred so user input can cancel it.
      if (resized && mode.current === 'following') scheduleEnd();
      viewport.dispatchEvent(new Event(SCROLL_LAYOUT_EVENT));
    });
    layout.observe(content);
    layout.observe(viewport);
    viewport.addEventListener('scroll', syncReadingIntent, { passive: true });
    viewport.addEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
    document.addEventListener('selectionchange', pauseForSelection);
    for (const name of ['wheel', 'touchmove', 'keydown'])
      viewport.addEventListener(name, read, { passive: true });
    return () => {
      cancelAnimationFrame(endFrame.current);
      layout.disconnect();
      viewport.removeEventListener('scroll', syncReadingIntent);
      viewport.removeEventListener(PAUSE_FOLLOW_EVENT, pauseFollowing);
      document.removeEventListener('selectionchange', pauseForSelection);
      for (const name of ['wheel', 'touchmove', 'keydown'])
        viewport.removeEventListener(name, read);
    };
  }, [viewport, content, resetKey, pauseFollowing, scrollToBottom, setMode, mode, scheduleEnd]);

  return {
    viewport,
    viewportRef,
    content,
    contentRef,
    pauseFollowing,
    scrollToBottom,
  };
}
