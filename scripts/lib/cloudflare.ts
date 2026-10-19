import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
let credentials: Promise<Record<string, string>> | undefined;
async function headers() {
  credentials ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everchat-cloudflare-auth-'));
    try {
      const { stdout } = await execute(
        process.execPath,
        [resolve('node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'],
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            WRANGLER_LOG_PATH: join(directory, 'auth.log'),
            WRANGLER_SEND_METRICS: 'false',
          },
        },
      );
      const auth = JSON.parse(stdout) as {
        token?: string;
        type: string;
        key?: string;
        email?: string;
      };
      if (!auth.token) throw new Error('OAuth or API token required');
      return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    } catch {
      throw new Error('Cannot load Cloudflare token; credential output suppressed.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return credentials;
}
export async function cloudflareRead<T = unknown>(path: string) {
  if (!path.startsWith('/accounts/')) throw new Error('Only account reads are supported');
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: await headers(),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const payload = (await response.json()) as {
    result?: T;
    success: boolean;
    errors?: { code: number; message: string }[];
  };
  return { status: response.status, ...payload };
}
export async function cloudflareQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) {
  if (!/^\s*(query\s|\{)/.test(query)) throw new Error('Only GraphQL queries are supported');
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: await headers(),
    redirect: 'error',
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cloudflare analytics HTTP ${response.status}`);
  return response.json() as Promise<{ data?: T; errors?: { message: string }[] }>;
}
