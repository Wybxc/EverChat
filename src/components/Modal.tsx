import { actionMenuReturnTarget } from './ActionMenu';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog';

let openModals = 0;
export const hasOpenModal = () => openModals > 0;
const AlertContext = createContext(false);

/** Business dialogs share dismissal and focus policy; primitives own trapping and portals. */
export function Modal({
  open,
  onOpenChange,
  children,
  alert = false,
  initialFocus,
  busy = false,
  finalFocus,
  ...props
}: {
  open: boolean;
  onOpenChange: NonNullable<ComponentProps<typeof Dialog>['onOpenChange']>;
  children: ReactElement;
  alert?: boolean;
  busy?: boolean;
} & Omit<ComponentProps<typeof DialogContent>, 'children'>) {
  const previousOpen = useRef(false),
    restoreTarget = useRef<HTMLElement | null>(null),
    content = useRef<HTMLDivElement>(null);
  if (open && !previousOpen.current) {
    const active = document.activeElement;
    restoreTarget.current =
      active instanceof HTMLElement && active.closest('[role="menu"]')
        ? actionMenuReturnTarget()
        : active instanceof HTMLElement
          ? active
          : null;
  }
  previousOpen.current = open;
  useEffect(() => {
    if (open) {
      openModals++;
      return () => {
        openModals--;
      };
    }
  }, [open]);
  const { className, children: body, ...bodyProps } = children.props as ComponentProps<'div'>;
  const Root = alert ? AlertDialog : Dialog;
  const Content = alert ? AlertDialogContent : DialogContent;
  return (
    <AlertContext.Provider value={alert}>
      <Root
        open={open}
        {...(!alert ? { disablePointerDismissal: busy } : {})}
        onOpenChange={(next, details) => {
          if (busy) details.cancel();
          else onOpenChange(next, details);
        }}
      >
        <Content
          ref={content}
          {...bodyProps}
          className={cn(className)}
          {...(!alert ? { showCloseButton: false } : {})}
          aria-describedby={undefined}
          initialFocus={(interaction) => {
            if (typeof initialFocus === 'function') return initialFocus(interaction);
            if (initialFocus && typeof initialFocus === 'object') {
              const target = initialFocus.current;
              if (target instanceof HTMLInputElement) target.select();
              return target;
            }
            return initialFocus ?? true;
          }}
          finalFocus={(interaction) => {
            if (typeof finalFocus === 'function') {
              const target = finalFocus(interaction);
              if (target !== true && target !== null) return target;
            } else if (finalFocus !== undefined)
              return typeof finalFocus === 'object' ? finalFocus.current : finalFocus;
            // A new page or dialog may deliberately claim focus during dismissal.
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              active !== document.body &&
              active.checkVisibility() &&
              !content.current?.contains(active)
            )
              return false;
            const target = restoreTarget.current;
            return target?.isConnected && target.checkVisibility() && !target.closest('[inert]')
              ? target
              : true;
          }}
          {...props}
        >
          {body}
        </Content>
      </Root>
    </AlertContext.Provider>
  );
}
export function ModalTitle(props: ComponentProps<typeof DialogTitle>) {
  const Title = useContext(AlertContext) ? AlertDialogTitle : DialogTitle;
  return <Title {...props} />;
}
