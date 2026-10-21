import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import { type UiMessage, renderUiMessage } from '../../platform/i18n/messages';
import './locales';
import type { ReadingAction } from './useMessageNavigation';
import { useNavigationVisibility } from './useNavigationVisibility';

export function ConversationNavigation({
  visible,
  viewport,
  vertical,
  atTop,
  atBottom,
  previous,
  next,
  announcement,
  navigate,
}: {
  visible: boolean;
  viewport: HTMLElement | null;
  vertical: boolean;
  atTop: boolean;
  atBottom: boolean;
  previous?: string;
  next?: string;
  announcement: UiMessage;
  navigate: (action: ReadingAction) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const touch = useRef(false);
  const visibility = useNavigationVisibility(viewport, visible);
  const [openTooltip, setOpenTooltip] = useState<ReadingAction | null>(null);
  useEffect(() => {
    if (!visible) {
      touch.current = false;
      setOpenTooltip(null);
    }
  }, [visible]);
  if (!visible) return null;
  const actions = [
    { id: 'top', label: t(($) => $.jumpTop), icon: ArrowUpToLine, unavailable: atTop },
    { id: 'previous', label: t(($) => $.previousAnswer), icon: ChevronUp, unavailable: !previous },
    { id: 'next', label: t(($) => $.nextAnswer), icon: ChevronDown, unavailable: !next },
    { id: 'bottom', label: t(($) => $.jumpBottom), icon: ArrowDownToLine, unavailable: atBottom },
  ] satisfies { id: ReadingAction; label: string; icon: typeof ChevronUp; unavailable: boolean }[];
  return (
    <TooltipProvider delay={400}>
      <div
        className="conversation-navigation"
        data-active={visibility.active || undefined}
        role="group"
        aria-label={t(($) => $.readingNavigation)}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') visibility.enter();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') visibility.leave();
        }}
        onPointerDownCapture={(event) => {
          touch.current = event.pointerType === 'touch';
          if (touch.current) setOpenTooltip(null);
        }}
        onPointerMoveCapture={(event) => {
          // WebKit can synthesize mouse movement after a tap while the viewport animates.
          if (
            event.pointerType === 'mouse' &&
            matchMedia('(hover: hover) and (pointer: fine)').matches
          )
            touch.current = false;
        }}
        onKeyDownCapture={() => {
          touch.current = false;
          visibility.show();
        }}
        onFocusCapture={(event) => {
          if (event.target.matches(':focus-visible')) touch.current = false;
          visibility.show();
        }}
      >
        {actions.map(({ id, label, icon: Icon, unavailable }) => (
          <Tooltip
            key={id}
            open={openTooltip === id}
            onOpenChange={(open) => {
              setOpenTooltip((current) =>
                open ? (touch.current ? null : id) : current === id ? null : current,
              );
            }}
          >
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={label}
                  aria-disabled={unavailable}
                  onClick={(event) => {
                    // Safari does not focus a button on pointer activation by default.
                    event.currentTarget.focus({ preventScroll: true });
                    visibility.show();
                    // Layout can change after the rendered boundary state; the hook reads it fresh.
                    navigate(id);
                  }}
                />
              }
            >
              <Icon
                className={`size-[min(1rem,24px)] ${unavailable ? 'opacity-40' : ''}`}
                aria-hidden
              />
            </TooltipTrigger>
            <TooltipContent side={vertical ? 'left' : 'top'} sideOffset={8}>
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {renderUiMessage(announcement)}
        </span>
      </div>
    </TooltipProvider>
  );
}
