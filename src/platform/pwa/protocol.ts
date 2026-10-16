export const APP_VERSION = import.meta.env.VITE_APP_VERSION as string;
export const STATIC_CACHE_PREFIX = 'everchat-static-';
export const PWA_CHANNEL = 'everchat:pwa';
export type ReloadCommand = 'update' | 'repair';
export type Preparation = { ready: boolean; reason?: string };
