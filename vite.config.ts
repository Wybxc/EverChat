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
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/^\/api\//],
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
    },
  }), cloudflare({
    persistState: process.env.EVERCHAT_TEST_STATE ? { path: process.env.EVERCHAT_TEST_STATE } : true,
    ...(process.env.EVERCHAT_TEST_STATE ? { inspectorPort: false } : {}),
    ...(process.env.EVERCHAT_MOCK_PROVIDER === '1' ? { config: {
      main: 'tests/fixtures/worker.ts',
      ...(process.env.EVERCHAT_GENERATION_METRICS === '1' || process.env.EVERCHAT_TOOL_METRICS === '1' ? { vars: {
        ...(process.env.EVERCHAT_GENERATION_METRICS === '1' ? { GENERATION_METRICS: '1' } : {}),
        ...(process.env.EVERCHAT_TOOL_METRICS === '1' ? { LOCAL_RESOURCE_METRICS: '1',
          LOCAL_MEASUREMENT_RUN: process.env.EVERCHAT_MEASUREMENT_RUN ?? '',
          LOCAL_TOOL_WORKLOAD: process.env.EVERCHAT_TOOL_WORKLOAD ?? '{"chunks":120,"interval":25,"size":200}' } : {}),
      } } : {}),
    } } : {}),
  })],
  server: { port: 5173, strictPort: true },
});
