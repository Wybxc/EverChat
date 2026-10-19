import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [suite, ...args] = process.argv.slice(2);
if (!['unit', 'e2e', 'pwa'].includes(suite))
  throw new Error('Usage: scripts/test.ts unit|e2e|pwa [runner arguments]');
let command: string[];
if (suite === 'unit') {
  const files = globSync('tests/**/*.test.ts').sort();
  if (!files.length) throw new Error('No unit tests discovered.');
  if (args.includes('--list')) {
    process.stdout.write(files.join('\n') + '\n');
    process.exit(0);
  }
  command = ['--import', 'tsx/esm', '--test', ...args, ...files];
} else {
  command = [resolve('node_modules/@playwright/test/cli.js'), 'test', ...args];
}
const result = spawnSync(process.execPath, command, {
  stdio: 'inherit',
  env: { ...process.env, EVERCHAT_TEST_SUITE: suite },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
