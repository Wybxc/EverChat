import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { pageI18n } from './platform/i18n/react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import { AccessGate } from './app/AccessGate';
import type { SettingsTab } from './app/SettingsPanel';
import { hydrateStorage } from './platform/storage';
import { startPwa } from './platform/pwa/controller';
import { PwaNotice } from './platform/pwa/PwaControls';

import './style.css';

const storageReady = hydrateStorage();
function Bootstrap() {
  const [ready, setReady] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>();
  React.useEffect(() => {
    let active = true;
    void storageReady.then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);
  return ready ? (
    <App initialSettings={{ open: settingsOpen, tab: settingsTab }} />
  ) : (
    <AccessGate
      status="loading"
      error=""
      onRetry={() => {}}
      logoutUrl="/cdn-cgi/access/logout"
      settingsState={{
        open: settingsOpen,
        tab: settingsTab,
        change: setSettingsOpen,
        selectTab: setSettingsTab,
      }}
    />
  );
}

export function start() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true },
    },
  });
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nextProvider i18n={pageI18n}>
        <QueryClientProvider client={queryClient}>
          <Bootstrap />
          <PwaNotice />
        </QueryClientProvider>
      </I18nextProvider>
    </React.StrictMode>,
  );
  startPwa();
}
