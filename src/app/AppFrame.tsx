import type { ReactNode } from 'react';
import { Plus, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Brand } from './Brand';
import { ariaShortcut, shortcutLabel } from './commands';

export function AppFrame({
  sidebar,
  header,
  children,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden" data-testid="app-frame">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="chat-header flex shrink-0 items-center gap-2">{header}</header>
        {children}
      </div>
    </div>
  );
}

export function SidebarHeader({ toggle, create }: { toggle: () => void; create?: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between min-h-14 px-3 py-1.5">
        <Brand small />
        <Button variant="ghost" size="icon" aria-label="收起侧栏" onClick={toggle}>
          <X className="size-[1.125rem]" />
        </Button>
      </div>
      <div className="px-3">
        <Button
          variant="secondary"
          disabled={!create}
          onClick={create}
          aria-label="开启新对话"
          aria-keyshortcuts={ariaShortcut('new-chat')}
          title={`开启新对话（${shortcutLabel('new-chat')}）`}
          className="h-11 w-full justify-between bg-accent px-4 text-sm font-medium text-accent-foreground"
        >
          <span className="flex items-center gap-2.5">
            <Plus className="size-[1.0625rem]" />
            开启新对话
          </span>
          <kbd className="text-xs text-muted-foreground">{shortcutLabel('new-chat')}</kbd>
        </Button>
      </div>
    </>
  );
}

export function SpaceSettingsButton({ open }: { open: () => void }) {
  return (
    <Button
      variant="ghost"
      aria-label="空间设置"
      className="mx-2 mb-2 flex min-h-11 items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-border"
      onClick={open}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background text-xs">
        我
      </span>
      <span className="flex-1">
        <span className="block text-xs font-medium">私人空间</span>
      </span>
      <Settings className="size-4" />
    </Button>
  );
}

export function LoadingContent({ label = '读取中' }: { label?: string }) {
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
