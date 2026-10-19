import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
const help = `Usage: pnpm measure <command> [options]

  stream          --runtime local|cloudflare (default: local)
                  Cloudflare suites: functional|sustained|reconnect|history
  tools           --runtime local|cloudflare (default: local)
                  --mode diagnostics|platform (local default: diagnostics)
                  Platform suites: functional|large|sustained|all (all is local only)
  notifications   --suite transport|pipeline --url <isolated-fixture> --secrets <file>
                  Default: Cloudflare. Local fixture: --runtime local, port 5182
  usage           --runtime local|cloudflare (default: local)
                  Cloudflare actions: prepare|run|metrics --directory <private-dir>
  metrics         Cloudflare platform analytics for an isolated validation report
  tail            Sanitized logs from an isolated validation Worker

Suite-specific arguments are passed through. Local runs use mock suppliers.
Cloudflare runs require an explicitly deployed isolated fixture and credentials.
See docs/measurements/README.md for examples and cleanup requirements.
`;
if (!command || command === '--help' || args.includes('--help')) {
  process.stdout.write(help);
  process.exit(command ? 0 : 1);
}
assert.ok(
  ['stream', 'tools', 'notifications', 'usage', 'metrics', 'tail'].includes(command),
  'Unknown measurement command',
);
function take(name: string) {
  const matches = args.flatMap((value, index) =>
    value === name || value.startsWith(name + '=') ? [index] : [],
  );
  assert.ok(matches.length <= 1, `Duplicate ${name}`);
  if (!matches.length) return undefined;
  const index = matches[0],
    value = args[index];
  const result =
    value === name ? args.splice(index, 2)[1] : args.splice(index, 1)[0].slice(name.length + 1);
  assert.ok(result && !result.startsWith('--'), `${name} needs a value`);
  return result;
}
const runtime =
  take('--runtime') ??
  (['notifications', 'metrics', 'tail'].includes(command) ? 'cloudflare' : 'local');
assert.ok(['local', 'cloudflare'].includes(runtime), 'Unknown runtime');
const mode = take('--mode');
assert.ok(!mode || command === 'tools', '--mode is only available for tools');
let entry: string;
switch (command) {
  case 'stream': {
    const suite = take('--suite');
    if (runtime === 'local') {
      assert.ok(!suite, 'Local stream diagnostics run all scenarios');
      entry = 'stream-baseline';
    } else if (suite === 'history') entry = 'history-cloudflare';
    else {
      entry = 'stream-cloudflare';
      if (suite) args.push('--suite', suite);
    }
    break;
  }
  case 'tools': {
    const selected = mode ?? (runtime === 'local' ? 'diagnostics' : 'platform');
    assert.ok(['diagnostics', 'platform'].includes(selected), 'Unknown tool measurement mode');
    assert.ok(selected === 'platform' || runtime === 'local', 'Diagnostic counters are local only');
    entry = selected === 'diagnostics' ? 'tool-baseline' : 'tools';
    if (selected === 'platform') args.push('--runtime', runtime);
    break;
  }
  case 'notifications':
    entry = 'notifications';
    args.push('--runtime', runtime);
    break;
  case 'usage':
    entry = runtime === 'local' ? 'usage-ledger' : 'usage-sharing-cloudflare';
    assert.ok(runtime !== 'local' || args.length === 0, 'Local usage measurement takes no options');
    break;
  default:
    assert.equal(runtime, 'cloudflare', 'This command reads Cloudflare platform data');
    entry = command === 'metrics' ? 'cloudflare-metrics' : 'cloudflare-tail';
}
const url = new URL(`./measurements/${entry}.ts`, import.meta.url);
process.argv = [process.argv[0], fileURLToPath(url), ...args];
await import(url.href);
