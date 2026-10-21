'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

function Progress({
  className,
  value,
  shape = 'bar',
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { shape?: 'bar' | 'circle' }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        shape === 'circle'
          ? 'relative size-4 shrink-0'
          : 'bg-muted h-1 rounded-full relative flex w-full items-center overflow-x-hidden',
        className,
      )}
      {...props}
    >
      {shape === 'circle' ? (
        <svg
          viewBox="0 0 24 24"
          className="size-full -rotate-90"
          aria-hidden="true"
          fill="none"
          strokeWidth="3"
        >
          <circle data-slot="progress-track" cx="12" cy="12" r="9" className="stroke-input" />
          <circle
            data-slot="progress-indicator"
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            className="stroke-foreground"
            strokeLinecap="round"
            strokeDasharray={`${value ?? 0} 100`}
            visibility={value ? undefined : 'hidden'}
          />
        </svg>
      ) : (
        <ProgressPrimitive.Track className="h-full w-full">
          <ProgressPrimitive.Indicator
            data-slot="progress-indicator"
            className="bg-accent-foreground h-full transition-all"
          />
        </ProgressPrimitive.Track>
      )}
    </ProgressPrimitive.Root>
  );
}

export { Progress };
