import { actionMenuReturnTarget } from './ActionMenu';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactElement,
  type RefObject,
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
  onCloseAutoFocus,
  onOpenAutoFocus,
  ...props
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement;
  alert?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
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
        onOpenChange={(next) => {
          if (!busy) onOpenChange(next);
        }}
      >
        <Content
          ref={content}
          {...bodyProps}
          className={cn(className)}
          {...(!alert ? { showCloseButton: false } : {})}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            if (!event.defaultPrevented && initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
              if (initialFocus.current instanceof HTMLInputElement) initialFocus.current.select();
            }
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            // Closing animations must not undo a focus choice made after dismissal.
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              active !== document.body &&
              active.checkVisibility() &&
              !content.current?.contains(active)
            ) {
              event.preventDefault();
              return;
            }
            const target = restoreTarget.current;
            if (target?.isConnected && target.checkVisibility() && !target.closest('[inert]')) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
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
