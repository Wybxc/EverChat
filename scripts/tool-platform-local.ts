import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { runToolValidation, type ToolValidationSuite } from './tool-platform-runner';
import type { ToolValidationIdentity } from './measurements/support/validation';
const { values } = parseArgs({ options: { port: { type: 'string', default: '5191' }, suite: { type: 'string', default: 'all' },
  output: { type: 'string', default: '/tmp/everchat-tools-platform-local' } } });
const port = Number(values.port);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid port');
assert.ok(['all', 'functional', 'large', 'sustained'].includes(values.suite!), 'Invalid suite');
const directory = await mkdtemp(join(tmpdir(), 'everchat-tool-platform-')), origin = `http://127.0.0.1:${port}`;
const password = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex'), runId = randomUUID();
const config = JSON.parse(await readFile('wrangler.tool-validation.jsonc', 'utf8'));
delete config.$schema; config.main = resolve(config.main);
await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config));
await writeFile(join(directory, '.dev.vars'), `APP_PASSWORD=${password}\nSESSION_SECRET=${secret}\nVALIDATION_RUN_ID=${runId}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', join(directory, 'wrangler.json'),
  '--persist-to', join(directory, 'state'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
});
let log = '', serverError: Error | undefined, complete = false;
child.on('error', (error) => { serverError = error; });
const closed = new Promise<void>((done) => child.once('close', () => done()));
for (const stream of [child.stdout, child.stderr]) stream.on('data', (value) => { log = (log + String(value)).slice(-32768); });
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    if (serverError) throw serverError;
    assert.ok(child.exitCode === null && child.signalCode === null, 'Validation runtime exited before readiness');
    let identity: ToolValidationIdentity | undefined;
    try { const response = await fetch(`${origin}/api/__validation/identity`, { redirect: 'error', signal: AbortSignal.timeout(500) });
      if (response.ok) identity = await response.json() as ToolValidationIdentity; } catch { /* Startup only; identity checked before any mutations. */ }
    if (identity) { assert.equal(identity.runId, runId, 'Another runtime owns the port; refusing to log in'); break; }
    assert.ok(Date.now() < deadline, 'Validation runtime startup timed out'); await pause(200);
  }
  const suites = (values.suite === 'all' ? ['functional', 'large', 'sustained'] : [values.suite!]) as ToolValidationSuite[];
  for (const suite of suites) await runToolValidation({ url: origin, password, runId, runtime: 'local', suite, output: `${values.output}-${suite}.json` });
  complete = true;
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5000); await closed; clearTimeout(force);
  }
  if (!complete) {
    for (const value of [password, secret, runId]) log = log.replaceAll(value, '[redacted]');
    await writeFile(join(tmpdir(), 'everchat-tool-platform-failure.log'), log, { mode: 0o600 });
  }
  await rm(directory, { recursive: true, force: true });
}
