import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function UserMessageBubble({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-[1.375rem] bg-user-message text-user-message-foreground px-4 py-2.5 text-base leading-7 whitespace-pre-wrap break-words',
        className,
      )}
    />
  );
}
