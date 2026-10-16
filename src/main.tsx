import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import { AccessGate } from './app/AccessGate';
import type { SettingsTab } from './app/SettingsPanel';
import { hydrateStorage } from './platform/storage';

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

function start() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true },
    },
  });
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <Bootstrap />
      </QueryClientProvider>
    </React.StrictMode>,
  );
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const register = () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        console.warn('EverChat service worker could not be registered');
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

void start();
