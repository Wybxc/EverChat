import { createContext, useContext, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

let lastTrigger: HTMLButtonElement | null = null;
export const actionMenuReturnTarget = () => lastTrigger;
const PendingAction = createContext<((action: () => void) => void) | null>(null);
export function ActionMenuItem({
  onClick,
  keepOpen = false,
  ...props
}: ComponentProps<typeof DropdownMenuItem> & { keepOpen?: boolean }) {
  const queue = useContext(PendingAction);
  return (
    <DropdownMenuItem
      {...props}
      closeOnClick={!keepOpen}
      onClick={(event) => {
        if (onClick && queue && !keepOpen) queue(() => onClick(event));
        else onClick?.(event);
      }}
    />
  );
}
export const ActionMenuGroup = DropdownMenuGroup;
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
        <DropdownMenuTrigger
          render={
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
            />
          }
        >
          {icon}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          finalFocus={() => {
            const action = pending.current;
            pending.current = null;
            if (action) {
              trigger.current?.focus({ preventScroll: true });
              action();
              return false;
            }
            return true;
          }}
          aria-label={label}
          side={placement.includes('top') ? 'top' : 'bottom'}
          align={placement.includes('start') ? 'start' : 'end'}
          sideOffset={4}
          className="w-60 max-w-[calc(100vw-1rem)]"
        >
          <DropdownMenuGroup>{children}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </PendingAction.Provider>
  );
}
