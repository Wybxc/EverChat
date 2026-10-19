import { unstable_readConfig } from 'wrangler';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { runToolValidation, type ToolValidationSuite } from './support/tool-platform-runner';
import type { ToolValidationIdentity } from './support/validation';
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5191' },
    suite: { type: 'string', default: 'all' },
    output: { type: 'string', default: '/tmp/everchat-tools-platform-local' },
  },
});
const port = Number(values.port);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid port');
assert.ok(['all', 'functional', 'large', 'sustained'].includes(values.suite!), 'Invalid suite');
const directory = await mkdtemp(join(tmpdir(), 'everchat-tool-platform-')),
  origin = `http://127.0.0.1:${port}`;
const runId = randomUUID();
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: runId, alg: 'RS256', use: 'sig' };
const token = await new SignJWT({ type: 'app', email: 'developer@everchat.local' })
  .setProtectedHeader({ alg: 'RS256', kid: runId })
  .setIssuer('http://everchat.local.invalid')
  .setAudience('everchat-local')
  .setSubject('local-developer')
  .setIssuedAt()
  .setExpirationTime('12h')
  .sign(privateKey);
const access = { origin, headers: { Cookie: `everchat_dev_access=${token}` } };
const source = unstable_readConfig({ config: 'config/wrangler.validation.jsonc', env: 'tools' });
const config = {
  name: source.name,
  compatibility_date: source.compatibility_date,
  compatibility_flags: source.compatibility_flags,
  vars: source.vars,
  durable_objects: source.durable_objects,
  workflows: source.workflows,
  migrations: source.migrations,
  observability: source.observability,
  main: '',
};
config.main = resolve('scripts/dev/validation-worker.ts');
config.vars = {
  ...config.vars,
  VALIDATION_RUN_ID: runId,
  DEV_ACCESS_PUBLIC_JWK: JSON.stringify(jwk),
  DEV_ACCESS_ORIGIN: origin,
};
await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config));
const child = spawn(
  process.execPath,
  [
    resolve('node_modules/wrangler/bin/wrangler.js'),
    'dev',
    '--local',
    '--config',
    join(directory, 'wrangler.json'),
    '--persist-to',
    join(directory, 'state'),
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
    },
  },
);
let log = '',
  serverError: Error | undefined,
  complete = false;
child.on('error', (error) => {
  serverError = error;
});
const closed = new Promise<void>((done) => child.once('close', () => done()));
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (value) => {
    log = (log + String(value)).slice(-32768);
  });
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    if (serverError) throw serverError;
    assert.ok(
      child.exitCode === null && child.signalCode === null,
      'Validation runtime exited before readiness',
    );
    let identity: ToolValidationIdentity | undefined;
    try {
      const response = await fetch(`${origin}/api/__validation/identity`, {
        redirect: 'error',
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) identity = (await response.json()) as ToolValidationIdentity;
    } catch {
      /* Startup only; identity checked before any mutations. */
    }
    if (identity) {
      assert.equal(
        identity.runId,
        runId,
        'Another runtime owns the port; refusing to change configuration',
      );
      break;
    }
    assert.ok(Date.now() < deadline, 'Validation runtime startup timed out');
    await pause(200);
  }
  const suites = (
    values.suite === 'all' ? ['functional', 'large', 'sustained'] : [values.suite!]
  ) as ToolValidationSuite[];
  for (const suite of suites)
    await runToolValidation({
      url: origin,
      access,
      runId,
      runtime: 'local',
      suite,
      output: `${values.output}-${suite}.json`,
    });
  complete = true;
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(force);
  }
  if (!complete) {
    for (const value of [token, runId]) log = log.replaceAll(value, '[redacted]');
    await writeFile(join(tmpdir(), 'everchat-tool-platform-failure.log'), log, { mode: 0o600 });
  }
  await rm(directory, { recursive: true, force: true });
}
