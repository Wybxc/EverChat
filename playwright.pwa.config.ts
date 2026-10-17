import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa',
  outputDir: 'test-results-pwa',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: [
        'lifecycle.spec.ts',
        'cloudflare-assets.spec.ts',
        'caching.spec.ts',
        'math.spec.ts',
      ],
    },
  ],
  webServer: {
    command: 'node --import tsx/esm tests/support/browser/pwa-server.ts',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 60_000,
  },
});
