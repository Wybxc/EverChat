import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
export function IconButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <TooltipProvider delay={400}>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon" aria-label={label} {...props} />}
        ></TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
