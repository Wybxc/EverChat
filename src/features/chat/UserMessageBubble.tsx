import { useTranslation } from 'react-i18next';
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Bubble, BubbleContent } from '@/components/ui/bubble';

export function UserMessageBubble({ className, ...props }: ComponentProps<'div'>) {
  const { t } = useTranslation('common', { useSuspense: false });

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
    <Bubble variant="user" align="end" className={cn('max-w-full', className)}>
      <BubbleContent data-collapsed-message={long && !expanded ? 'true' : undefined}>
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
            {expanded ? t(($) => $.collapseMessage) : t(($) => $.expandMessage)}
          </Button>
        )}
      </BubbleContent>
    </Bubble>
  );
}
