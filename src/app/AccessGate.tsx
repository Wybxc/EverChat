import { useTranslation } from 'react-i18next';
import './locales';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { completeSignOut, resumeAccess } from '../platform/auth';
import { ThemeControl } from './ThemeControl';
import type { SessionStatus } from './useSession';
import { AppFrame, LoadingContent, SidebarHeader, SpaceSettingsButton } from './AppFrame';
import { Sidebar } from '../features/library/Sidebar';
import { useSidebar } from './useSidebar';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { SettingsDialog } from './SettingsDialog';

export function AccessGate({
  status,
  error,
  onRetry,
  logoutUrl,
  settingsState,
}: {
  logoutUrl: string;
  status: SessionStatus;
  error: string;
  onRetry: () => void;
  settingsState?: {
    open: boolean;
    tab?: SettingsTab;
    change: (open: boolean) => void;
    selectTab: (tab: SettingsTab) => void;
  };
}) {
  const { t } = useTranslation('app', { useSuspense: false });

  const [online, setOnline] = useState(navigator.onLine);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false);
  const settingsOpen = settingsState?.open ?? localSettingsOpen;
  const setSettingsOpen = (open: boolean) => {
    setLocalSettingsOpen(open);
    settingsState?.change(open);
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const { desktop } = useSidebar(sidebarOpen, closeSidebar);
  const toggle = () =>
    desktop ? setCollapsed((value) => !value) : setSidebarOpen((value) => !value);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <>
      <AppFrame
        sidebar={
          <Sidebar
            desktop={desktop}
            collapsed={collapsed}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            trigger={trigger}
          >
            <SidebarHeader toggle={toggle} />
            <div className="min-h-0 flex-1 overflow-y-auto px-4">
              {status === 'loading' && <LoadingContent label={t(($) => $.loadingConversations)} />}
            </div>
            <SpaceSettingsButton
              open={() => {
                setSidebarOpen(false);
                setSettingsOpen(true);
              }}
            />
          </Sidebar>
        }
        header={
          <>
            <Button
              variant="ghost"
              size="icon"
              ref={trigger}
              className={`h-11 w-11 ${desktop && !collapsed ? 'hidden' : ''}`}
              onClick={toggle}
              aria-label={t(($) => $.openSidebar)}
              aria-expanded={desktop ? !collapsed : sidebarOpen}
            >
              <Menu className="size-5" />
            </Button>
            <p className="min-w-0 flex-1 text-sm font-medium">EverChat</p>
            <span role="status" className="px-3 text-xs text-muted-foreground">
              {status === 'loading' ? t(($) => $.connecting) : t(($) => $.disconnected)}
            </span>
          </>
        }
      >
        <section className="mx-auto flex w-full max-w-[49rem] flex-1 flex-col justify-center gap-5 px-4 pb-16">
          {status === 'loading' ? (
            <div className="rounded-3xl border border-input p-2.5" aria-busy="true">
              <LoadingContent label={t(($) => $.checkingIdentity)} />
            </div>
          ) : (
            <>
              <p role="alert" className="text-sm text-foreground">
                {status === 'denied'
                  ? t(($) => $.accessDenied)
                  : status === 'unavailable'
                    ? error || t(($) => $.connectionUnavailable)
                    : status === 'signed-out'
                      ? error || t(($) => $.signedOutOffline)
                      : t(($) => $.signInRequired)}
              </p>
              {status === 'unavailable' && (
                <Button variant="secondary" onClick={onRetry}>
                  {t(($) => $.reconnect)}
                </Button>
              )}
              {status === 'signed-out' ? (
                <Button
                  disabled={!error && !online}
                  onClick={error ? onRetry : () => completeSignOut(logoutUrl)}
                >
                  {error ? t(($) => $.retryClearData) : t(($) => $.finishSignOut)}
                </Button>
              ) : (
                <Button
                  onClick={status === 'denied' ? () => completeSignOut(logoutUrl) : resumeAccess}
                >
                  {status === 'denied' ? t(($) => $.switchAccount) : t(($) => $.signInAgain)}
                </Button>
              )}
            </>
          )}
        </section>
      </AppFrame>
      <SettingsPanel
        open={settingsOpen}
        requestedTab={settingsState?.tab}
        onTabChange={settingsState?.selectTab}
        authenticated={false}
        themeControl={<ThemeControl />}
        render={(content) => (
          <SettingsDialog open={settingsOpen} close={() => setSettingsOpen(false)}>
            {content}
          </SettingsDialog>
        )}
      />
    </>
  );
}
