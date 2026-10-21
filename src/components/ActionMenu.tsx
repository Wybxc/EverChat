import { useRef, type ComponentProps, type ReactNode } from 'react';
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
export function ActionMenuItem({
  onClick,
  keepOpen = false,
  ...props
}: ComponentProps<typeof DropdownMenuItem> & { keepOpen?: boolean }) {
  return <DropdownMenuItem {...props} closeOnClick={!keepOpen} onClick={onClick} />;
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
  const trigger = useRef<HTMLButtonElement>(null);
  return (
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
        aria-label={label}
        side={placement.includes('top') ? 'top' : 'bottom'}
        align={placement.includes('start') ? 'start' : 'end'}
        sideOffset={4}
        className="w-60 max-w-[calc(100vw-1rem)]"
      >
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
