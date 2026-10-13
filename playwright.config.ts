import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = 'http://127.0.0.1:5174';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { baseURL: origin, trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174', url: origin, reuseExistingServer: false,
    env: { EVERCHAT_TEST_STATE: mkdtempSync(join(tmpdir(), 'everchat-e2e-')), EVERCHAT_MOCK_PROVIDER: '1' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 60_000,
  },
});
