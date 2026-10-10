import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { hydrateStorage } from './storage';
import './style.css';

async function start() {
  await hydrateStorage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true } } });
  createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></React.StrictMode>);
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
  }
}

void start();
