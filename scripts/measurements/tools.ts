import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { unstable_readConfig } from 'wrangler';
import { startLocalRuntime } from '../lib/runtime';
import { measurementAccess } from './support/credentials';
import { runToolValidation, type ToolValidationSuite } from './support/tool-platform-runner';
import type { ToolValidationIdentity } from './support/validation';
const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'local' },
    port: { type: 'string', default: '5191' },
    suite: { type: 'string', default: 'functional' },
    output: { type: 'string', default: '/tmp/everchat-tools-platform' },
    url: { type: 'string' },
    credentials: { type: 'string' },
  },
});
assert.ok(['local', 'cloudflare'].includes(values.runtime!), 'Unknown runtime');
assert.ok(['all', 'functional', 'large', 'sustained'].includes(values.suite!), 'Invalid suite');
if (values.runtime === 'cloudflare') {
  assert.ok(values.url && values.credentials, '--url and --credentials are required');
  const credentials = JSON.parse(await readFile(values.credentials, 'utf8')) as {
    VALIDATION_RUN_ID: string;
  };
  assert.ok(values.suite !== 'all', 'Choose a separate Cloudflare measurement window per suite');
  await runToolValidation({
    url: values.url,
    access: await measurementAccess(values.credentials, new URL(values.url).origin),
    runId: credentials.VALIDATION_RUN_ID,
    output: values.output!,
    suite: values.suite as ToolValidationSuite,
    runtime: 'cloudflare',
  });
} else {
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
  config.main = resolve('scripts/measurements/support/local-worker.ts');
  config.vars = {
    ...config.vars,
    VALIDATION_RUN_ID: runId,
    DEV_ACCESS_PUBLIC_JWK: JSON.stringify(jwk),
    DEV_ACCESS_ORIGIN: origin,
  };
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config));
  const runtime = await startLocalRuntime({
    name: 'tools-platform',
    port,
    directory,
    command: [
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
  });
  try {
    await runtime.ready(async () => {
      const response = await fetch(origin + '/api/__validation/identity', {
        redirect: 'error',
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return false;
      const identity = (await response.json()) as ToolValidationIdentity;
      return identity.runId === runId;
    });
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
  } finally {
    await runtime.stop();
  }
}
