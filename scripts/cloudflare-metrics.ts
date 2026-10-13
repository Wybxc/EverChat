import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cloudflareQuery, cloudflareRead } from './cloudflare-api';
const { values } = parseArgs({ options: {
  account: { type: 'string' }, functional: { type: 'string', default: 'docs/measurements/cloudflare-functional.json' },
  output: { type: 'string', default: '/tmp/everchat-cloudflare-metrics.json' },
  url: { type: 'string' }, credentials: { type: 'string' },
  'namespace-report': { type: 'string' },
} });
assert.ok(values.account && /^[a-f0-9]{32}$/.test(values.account), '--account must be a Cloudflare account ID');
const functional = JSON.parse(await readFile(values.functional!, 'utf8')) as { workerName: string; startedAt: string; finishedAt: string; complete: boolean };
assert.equal(functional.workerName, 'everchat-stream-validation');
assert.equal(functional.complete, true, 'Use a complete functional run for platform validation');
assert.ok(Number.isFinite(Date.parse(functional.startedAt)) && Number.isFinite(Date.parse(functional.finishedAt)));
assert.ok(Date.parse(functional.finishedAt) >= Date.parse(functional.startedAt));
let namespaces: { name: string; id: string }[];
if (values['namespace-report']) {
  const source = JSON.parse(await readFile(values['namespace-report'], 'utf8')) as { workerName: string; namespaces: typeof namespaces };
  assert.equal(source.workerName, functional.workerName); namespaces = source.namespaces;
} else {
  const settings = await cloudflareRead<{ bindings: { name: string; type: string; namespace_id?: string }[] }>(`/accounts/${values.account}/workers/scripts/${functional.workerName}/settings`);
  assert.ok(settings.success && settings.result, `Cannot read validation namespaces: HTTP ${settings.status}`);
  namespaces = settings.result.bindings.filter((binding) => binding.type === 'durable_object_namespace').map(({ name, namespace_id }) => ({ name, id: namespace_id! }));
}
assert.equal(namespaces.length, 2); assert.ok(namespaces.every(({ id }) => /^[a-f0-9]{32}$/.test(id)));
assert.deepEqual(namespaces.map(({ name }) => name).sort(), ['CONVERSATIONS', 'LIBRARY']);
assert.equal(new Set(namespaces.map(({ id }) => id)).size, 2);
const start = new Date(Math.floor(Date.parse(functional.startedAt) / 60000) * 60000).toISOString();
const end = new Date(Math.ceil(Date.parse(functional.finishedAt) / 60000) * 60000 + 60000).toISOString();
// Storage is sampled independently from invocations; include later samples in a separate window.
const storageStart = new Date(Math.floor(Date.parse(start) / 3600000) * 3600000).toISOString();
const storageEnd = new Date().toISOString();
const time = `datetime_geq:${JSON.stringify(start)}, datetime_lt:${JSON.stringify(end)}`;
const identifiers = JSON.stringify(namespaces.map(({ id }) => id));
const query = `{ viewer { accounts(filter:{accountTag:${JSON.stringify(values.account)}}) {
  workersInvocationsAdaptive(limit:1000, filter:{${time}, scriptName:${JSON.stringify(functional.workerName)}}) {
    dimensions { status usageModel } avg { sampleInterval } sum { requests errors cpuTimeUs } max { cpuTime memoryUsageBytes } quantiles { cpuTimeP50 cpuTimeP99 }
  }
  durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{${time}, namespaceId_in:${identifiers}}) {
    dimensions { namespaceId type status } avg { sampleInterval } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 }
  }
  durableObjectsPeriodicGroups(limit:1000, filter:{${time}, namespaceId_in:${identifiers}}) {
    dimensions { namespaceId } avg { sampleInterval } sum { activeTime cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors fatalInternalErrors inboundWebsocketMsgCount outboundWebsocketMsgCount }
  }
  durableObjectsSqlStorageGroups(limit:1000, filter:{datetime_geq:${JSON.stringify(storageStart)}, datetime_lt:${JSON.stringify(storageEnd)}, namespaceId_in:${identifiers}}) { dimensions { namespaceId datetime } max { storedBytes } }
} } }`;
const response = await cloudflareQuery<{ viewer: { accounts: Record<string, unknown>[] } }>(query);
const datasets = response.data?.viewer.accounts[0];
const available = Object.fromEntries(['workersInvocationsAdaptive', 'durableObjectsInvocationsAdaptiveGroups', 'durableObjectsPeriodicGroups', 'durableObjectsSqlStorageGroups']
  .map((key) => [key, Array.isArray(datasets?.[key]) && (datasets[key] as unknown[]).length > 0]));
let deployedStorage: unknown;
if (values.url || values.credentials) {
  assert.ok(values.url && values.credentials, '--url and --credentials must be supplied together');
  const url = new URL(values.url);
  assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.startsWith('everchat-stream-validation.') && url.hostname.endsWith('.workers.dev'));
  const { APP_PASSWORD } = JSON.parse(await readFile(values.credentials, 'utf8')) as { APP_PASSWORD: string };
  assert.ok(APP_PASSWORD?.length >= 32);
  const login = await fetch(`${url.origin}/api/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: APP_PASSWORD }) });
  assert.ok(login.ok, `Validation login: HTTP ${login.status}`);
  const storage = await fetch(`${url.origin}/api/__validation/storage`, { redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } });
  assert.ok(storage.ok, `Deployed storage sample: HTTP ${storage.status}`);
  deployedStorage = await storage.json();
}
const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ version: 1, queriedAt: new Date().toISOString(), window: { start, end }, storageWindow: { start: storageStart, end: storageEnd }, workerName: functional.workerName, namespaces,
  units: { cpuTime: 'microseconds', cpuTimeUs: 'microseconds', activeTime: 'microseconds', duration: 'GB*s', storedBytes: 'bytes', memoryUsageBytes: 'bytes' },
  scope: 'Isolated deployed namespaces and Worker, diagnostic counters disabled. Adaptive fields may be sampled; empty arrays do not prove zero usage. Invocation minute rounding includes setup and idle activity. Storage uses a separate wider window and reports samples rather than the exact functional-run peak.',
  available, data: response.data, errors: response.errors, deployedStorage }, null, 2) + '\n');
if (response.errors?.length) { console.error(JSON.stringify(response.errors)); process.exitCode = 1; }
else console.log(JSON.stringify(response.data));
