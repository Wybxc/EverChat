import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Discover nested suites explicitly; an empty match must never look like success.
const files = globSync('tests/**/*.test.ts').sort();
if (!files.length) throw new Error('No unit tests discovered.');
if (process.argv.includes('--list')) {
  process.stdout.write(files.join('\n') + '\n');
} else {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
