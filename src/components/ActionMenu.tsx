import { createContext, useContext, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

let lastTrigger: HTMLButtonElement | null = null;
export const actionMenuReturnTarget = () => lastTrigger;
const PendingAction = createContext<((action: () => void) => void) | null>(null);
export function ActionMenuItem({
  onSelect,
  keepOpen = false,
  ...props
}: ComponentProps<typeof DropdownMenuItem> & { keepOpen?: boolean }) {
  const queue = useContext(PendingAction);
  return (
    <DropdownMenuItem
      {...props}
      onSelect={(event) => {
        if (keepOpen) {
          event.preventDefault();
          onSelect?.(event);
        } else if (onSelect && queue) queue(() => onSelect(event));
        else onSelect?.(event);
      }}
    />
  );
}
export const ActionMenuLabel = DropdownMenuLabel;
export const ActionMenuSeparator = DropdownMenuSeparator;
export function ActionMenu({
  label,
  icon,
  children,
  className = '',
  placement = '',
  disabled = false,
  open,
  onOpenChange,
  triggerData,
}: {
  triggerData?: string;
  label: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  placement?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null),
    pending = useRef<(() => void) | null>(null);
  return (
    <PendingAction.Provider
      value={(action) => {
        pending.current = action;
      }}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) lastTrigger = trigger.current;
          onOpenChange?.(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            data-action-menu={triggerData}
            type="button"
            variant="ghost"
            size="icon"
            className={className}
            aria-label={label}
            title={label}
            disabled={disabled}
          >
            {icon}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            const action = pending.current;
            pending.current = null;
            if (action) {
              event.preventDefault();
              trigger.current?.focus({ preventScroll: true });
              action();
            }
          }}
          aria-label={label}
          side={placement.includes('top') ? 'top' : 'bottom'}
          align={placement.includes('start') ? 'start' : 'end'}
          sideOffset={4}
          className="w-60 max-w-[calc(100vw-1rem)]"
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </PendingAction.Provider>
  );
}
