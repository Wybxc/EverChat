import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA({
    injectRegister: false,
    registerType: 'autoUpdate',
    includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
    manifest: {
      id: '/',
      name: 'EverChat · 让对话继续',
      short_name: 'EverChat',
      description: '断线不散，换端续聊。你的私人 AI 对话空间。',
      lang: 'zh-CN',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#fcfcfa',
      theme_color: '#285c50',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      navigateFallbackDenylist: [/^\/api\//],
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
    },
  }), cloudflare({ persistState: process.env.EVERCHAT_TEST_STATE ? { path: process.env.EVERCHAT_TEST_STATE } : true })],
  server: { port: 5173, strictPort: true },
});
