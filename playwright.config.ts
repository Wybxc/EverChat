import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const suite = process.env.EVERCHAT_TEST_SUITE ?? 'e2e';
if (!['e2e', 'pwa'].includes(suite)) throw new Error('Unknown Playwright suite');
const pwa = suite === 'pwa';
const origin = `http://127.0.0.1:${pwa ? 5175 : 5174}`;
export default defineConfig({
  testDir: pwa ? './tests/pwa' : './tests',
  ...(pwa ? {} : { testMatch: ['e2e/**/*.spec.ts', 'integration/**/*.spec.ts'] }),
  outputDir: pwa ? 'test-results-pwa' : 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { baseURL: origin, trace: 'retain-on-failure' },
  ...(pwa
    ? {
        projects: [
          { name: 'chromium', use: { browserName: 'chromium' as const } },
          {
            name: 'webkit',
            use: { browserName: 'webkit' as const },
            testMatch: [
              'lifecycle.spec.ts',
              'cloudflare-assets.spec.ts',
              'caching.spec.ts',
              'math.spec.ts',
              'sharing.spec.ts',
            ],
          },
        ],
      }
    : {}),
  webServer: {
    command: pwa
      ? 'node --import tsx/esm tests/support/browser/pwa-server.ts'
      : 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174',
    url: origin,
    reuseExistingServer: false,
    env: pwa
      ? {}
      : {
          EVERCHAT_TEST_STATE: mkdtempSync(join(tmpdir(), 'everchat-e2e-')),
          EVERCHAT_MOCK_PROVIDER: '1',
        },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 60_000,
  },
});
