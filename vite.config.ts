import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { localAccess } from './scripts/dev/access';
import { startupCache } from './scripts/build/startup-cache';

export default defineConfig(async ({ command, mode }) => {
  const local = command === 'serve' && mode !== 'access' ? await localAccess() : null;
  const startup = startupCache();
  return {
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        command === 'build'
          ? (process.env.EVERCHAT_BUILD_ID ?? new Date().toISOString())
          : 'development',
      ),
    },
    cacheDir: process.env.EVERCHAT_TEST_STATE
      ? `${process.env.EVERCHAT_TEST_STATE}/vite-cache`
      : 'node_modules/.vite',
    optimizeDeps: { include: ['fflate'] },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    plugins: [
      ...(local ? [local.plugin] : []),
      react(),
      tailwindcss(),
      startup.plugin,
      VitePWA({
        injectRegister: false,
        registerType: 'prompt',
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
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
          background_color: '#ffffff',
          theme_color: '#e45d8d',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          manifestTransforms: [
            async (manifest) => ({
              manifest: manifest.filter(({ url }) => startup.includes(url)),
              warnings: [],
            }),
          ],
        },
      }),
      cloudflare({
        persistState: process.env.EVERCHAT_TEST_STATE
          ? { path: process.env.EVERCHAT_TEST_STATE }
          : true,
        ...(process.env.EVERCHAT_TEST_STATE ? { inspectorPort: false } : {}),
        ...(local
          ? {
              config: {
                main:
                  process.env.EVERCHAT_MOCK_PROVIDER === '1'
                    ? 'tests/support/runtime/worker.ts'
                    : 'scripts/dev/worker.ts',
                vars: {
                  ...local.vars,
                  ...(process.env.EVERCHAT_GENERATION_METRICS === '1'
                    ? { GENERATION_METRICS: '1' }
                    : {}),
                  ...(process.env.EVERCHAT_TOOL_METRICS === '1'
                    ? {
                        LOCAL_RESOURCE_METRICS: '1',
                        LOCAL_MEASUREMENT_RUN: process.env.EVERCHAT_MEASUREMENT_RUN ?? '',
                        LOCAL_TOOL_WORKLOAD:
                          process.env.EVERCHAT_TOOL_WORKLOAD ??
                          '{"chunks":120,"interval":25,"size":200}',
                      }
                    : {}),
                },
              },
            }
          : {}),
      }),
    ],
    server: { port: 5173, strictPort: true },
  };
});
