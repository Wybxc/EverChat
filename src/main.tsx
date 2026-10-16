import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import { hydrateStorage } from './platform/storage';

import './style.css';

async function start() {
  await hydrateStorage();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true },
    },
  });
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
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
