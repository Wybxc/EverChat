import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function UserMessageBubble({ className, ...props }: ComponentProps<'div'>) {
  const content = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false),
    [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () =>
      setLong(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 10 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.children]);
  return (
    <div
      data-collapsed-message={long && !expanded ? 'true' : undefined}
      className={cn(
        'rounded-[1.375rem] bg-user-message text-user-message-foreground px-4 py-2.5 text-base leading-7 whitespace-pre-wrap break-words',
        className,
      )}
    >
      <div
        {...props}
        ref={content}
        className={!expanded ? 'max-h-[10lh] overflow-hidden' : undefined}
      />
      {long && (
        <Button
          variant="ghost"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="h-8 px-2 text-xs"
        >
          {expanded ? '收起消息' : '展开消息'}
        </Button>
      )}
    </div>
  );
}
