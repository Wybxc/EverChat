import { useTranslation } from 'react-i18next';
import { t } from './locales';
import type { ReactNode } from 'react';
import { Plus, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Brand } from './Brand';
import { ariaShortcut, shortcutLabel } from './commands';

export function AppFrame({
  sidebar,
  header,
  children,
  dropOverlay,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  dropOverlay?: ReactNode;
}) {
  const { t } = useTranslation('app', { useSuspense: false });

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden" data-testid="app-frame">
      {sidebar}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-chat-drop-zone>
        <header className="chat-header flex shrink-0 items-center gap-2">{header}</header>
        {children}
        {dropOverlay}
      </div>
    </div>
  );
}

export function SidebarHeader({ toggle, create }: { toggle: () => void; create?: () => void }) {
  const { t } = useTranslation('app', { useSuspense: false });

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center justify-between min-h-[56px] gap-2 px-3 py-1 [&>button]:shrink-0 [&>div]:min-w-0 [&>div]:overflow-hidden">
        <Brand small />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t(($) => $.collapseSidebar)}
          onClick={toggle}
        >
          <X className="size-[1.125rem]" />
        </Button>
      </div>
      <div className="shrink-0 px-3">
        <Button
          variant="secondary"
          disabled={!create}
          onClick={create}
          aria-label={t(($) => $.newChat)}
          aria-keyshortcuts={ariaShortcut('new-chat')}
          title={t(($) => $.newChatShortcut, { shortcut: shortcutLabel('new-chat') })}
          className="min-h-[44px] h-auto w-full justify-between gap-1 bg-accent px-3 py-1 text-sm font-medium text-accent-foreground"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Plus className="size-[1.0625rem] shrink-0" />
            <span className="truncate">{t(($) => $.newChat)}</span>
          </span>
          <kbd className="shrink-0 text-xs text-muted-foreground">{shortcutLabel('new-chat')}</kbd>
        </Button>
      </div>
    </>
  );
}

export function SpaceSettingsButton({ open }: { open: () => void }) {
  const { t } = useTranslation('app', { useSuspense: false });

  return (
    <Button
      variant="ghost"
      aria-label={t(($) => $.spaceSettings)}
      className="mx-2 mb-2 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-border"
      onClick={open}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background text-xs">
        {t(($) => $.me)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{t(($) => $.privateSpace)}</span>
      </span>
      <Settings className="size-4" />
    </Button>
  );
}

export function LoadingContent({ label = t(($) => $.loading) }: { label?: string }) {
  const { t } = useTranslation('app', { useSuspense: false });

  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="space-y-4 py-4"
      data-testid="loading-content"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        <div className="h-4 w-1/3 rounded bg-muted" />
        <div className="h-11 rounded-lg bg-muted" />
        <div className="h-4 w-1/2 rounded bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
      </div>
    </div>
  );
}
