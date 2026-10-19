// Isolated Cloudflare measurement using synthetic records only; no production bindings.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { cloudflareRead, cloudflareQuery } from './support/cloudflare-api';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    directory: { type: 'string' },
    account: { type: 'string' },
  },
});
assert.ok(values.directory, '--directory is required');
const directory = resolve(values.directory),
  workerName = 'everchat-usage-sharing-validation';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const save = async (file: string, value: unknown) =>
  writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const load = async <T>(file: string) =>
  JSON.parse(await readFile(join(directory, file), 'utf8')) as T;
type Manifest = { account: string; origin: string; token: string; run: string };
if (positionals[0] === 'prepare') {
  assert.ok(values.account && /^[a-f0-9]{32}$/.test(values.account), '--account is required');
  const subdomain = await cloudflareRead<{ subdomain: string }>(
    `/accounts/${values.account}/workers/subdomain`,
  );
  assert.ok(subdomain.success && subdomain.result);
  const manifest = {
    account: values.account,
    token: randomBytes(32).toString('base64url'),
    run: randomUUID(),
    origin: `https://${workerName}.${subdomain.result.subdomain}.workers.dev`,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), {
    mode: 0o600,
    flag: 'wx',
  });
  await save('worker.json', {
    name: workerName,
    account_id: values.account,
    main: resolve('scripts/measurements/support/usage-sharing-worker.ts'),
    compatibility_date: '2026-10-09',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    vars: { MEASUREMENT_TOKEN: manifest.token, MEASUREMENT_RUN: manifest.run },
    durable_objects: {
      bindings: [{ name: 'MEASUREMENTS', class_name: 'UsageSharingMeasurement' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['UsageSharingMeasurement'] }],
    observability: { enabled: true },
  });
  console.log(JSON.stringify({ prepared: true, workerName, directory }));
} else {
  const manifest = await load<Manifest>('manifest.json');
  assert.ok(
    new URL(manifest.origin).hostname.startsWith(`${workerName}.`) &&
      manifest.origin.endsWith('.workers.dev'),
  );
  const call = async <T = unknown>(path: string, mode: string, method = 'GET') => {
    const response = await fetch(
      `${manifest.origin}${path}${path.includes('?') ? '&' : '?'}mode=${mode}`,
      {
        method,
        headers: { Authorization: `Bearer ${manifest.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      },
    );
    assert.ok(response.ok, `Measurement HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
  if (positionals[0] === 'run') {
    const startedAt = new Date().toISOString(),
      emptyBytes: Record<string, number> = {};
    for (const mode of ['ledger', 'source', 'shares'])
      emptyBytes[mode] = (
        await call<{ emptyBytes: number }>('/initialize', mode, 'POST')
      ).emptyBytes;
    for (let start = 0; start < 100; start += 5)
      await call(`/run?start=${start}&count=5`, 'source', 'POST');
    const usage = {
      ledger: await call('/metrics', 'ledger'),
      source: await call('/metrics', 'source'),
    };
    const { id } = await call<{ id: string }>('/create', 'shares', 'POST');
    const created = await call('/metrics', 'shares');
    for (let index = 0; index < 30; index++) await call(`/read?id=${id}`, 'shares');
    const read = await call('/metrics', 'shares');
    await call(`/delete?id=${id}`, 'shares', 'POST');
    const report = {
      workerName,
      runtime: 'cloudflare',
      startedAt,
      finishedAt: new Date().toISOString(),
      requests: 100,
      publicFullReads: 30,
      emptyBytes,
      usage,
      shares: { created, read, reclaimed: await call('/metrics', 'shares') },
      note: 'Synthetic ledger/outbox and snapshot repository. Includes SQL cursor index accounting, but excludes generation/search/notification writes. Three source-to-ledger RPC per request. No AI calls; active duration does not model waiting for providers. API wrapper is measurement-only; functional private/public routes have separate integration tests.',
    };
    await save('functional.json', report);
    console.log(JSON.stringify(report, null, 2));
  } else if (positionals[0] === 'analytics') {
    const functional = await load<{ startedAt: string; finishedAt: string }>('functional.json');
    const settings = await cloudflareRead<{ bindings: { name: string; namespace_id?: string }[] }>(
      `/accounts/${manifest.account}/workers/scripts/${workerName}/settings`,
    );
    const namespace = settings.result?.bindings.find(
      (binding) => binding.name === 'MEASUREMENTS',
    )?.namespace_id;
    assert.ok(namespace);
    const start = new Date(
        Math.floor(Date.parse(functional.startedAt) / 60_000) * 60_000,
      ).toISOString(),
      end = new Date(
        Math.ceil(Date.parse(functional.finishedAt) / 60_000) * 60_000 + 60_000,
      ).toISOString(),
      filter = `datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}`;
    const report =
      await cloudflareQuery(`{ viewer { accounts(filter:{accountTag:${JSON.stringify(manifest.account)}}) {
      workersInvocationsAdaptive(limit:1000,filter:{${filter},scriptName:${JSON.stringify(workerName)}}) { dimensions {status} avg {sampleInterval} sum { requests errors cpuTimeUs } max {cpuTime} quantiles {cpuTimeP50 cpuTimeP99} }
      durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{${filter},namespaceId:${JSON.stringify(namespace)}}) { dimensions {type status} avg {sampleInterval} sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99} }
      durableObjectsPeriodicGroups(limit:1000,filter:{${filter},namespaceId:${JSON.stringify(namespace)}}) { avg {sampleInterval} sum {activeTime cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors} }
    } } }`);
    await save('analytics.json', { start, end, ...report });
    console.log(JSON.stringify({ start, end, ...report }, null, 2));
  } else if (positionals[0] === 'clear') {
    for (const mode of ['ledger', 'source', 'shares']) await call('/clear', mode, 'POST');
    console.log(JSON.stringify({ cleared: true, workerName }));
  } else throw new Error('Use prepare | run | analytics | clear');
}
