import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Use the real Static Assets runtime: the Node fault server cannot model HTML canonicalization. */
export async function startCloudflareAssets(root: string, temporary: string) {
  const main = join(temporary, 'assets-worker.mjs');
  await writeFile(
    main,
    `export default { fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/s' || path.startsWith('/s/')) return env.ASSETS.fetch(new Request(new URL('/share.html', request.url))).then(async response => new Response((await response.text()).replace('<!--EVERCHAT_SHARE-->', '<main>SSR fixture body</main>'), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'X-Fixture-Worker': 'invoked',  'Content-Security-Policy': "script-src 'self'", 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' }}));
    if (path.startsWith('/api/')) return Response.json({ authenticated: true, identity: { issuer: 'http://everchat.local.invalid', sub: 'local-developer', email: 'developer@everchat.local' }, providers: [], conversations: [], deletions: [], activity: {}, models: [] });
    return env.ASSETS.fetch(request).then(response => {
      const headers = new Headers(response.headers);
      headers.set('X-Fixture-Worker', 'invoked');
      return new Response(response.body, { status: response.status, headers });
    });
  } };`,
  );
  const children: ChildProcess[] = [];
  const productionHandling =
    (await readFile('wrangler.jsonc', 'utf8')).match(/"html_handling"\s*:\s*"([^"]+)"/)?.[1] ??
    'auto-trailing-slash';
  for (const [port, html_handling] of [
    [5178, 'auto-trailing-slash'],
    [5179, productionHandling],
  ] as const) {
    const config = join(temporary, `assets-${port}.json`);
    await writeFile(
      config,
      JSON.stringify({
        name: `everchat-assets-${port}`,
        main,
        compatibility_date: '2026-10-09',
        assets: {
          directory: root,
          binding: 'ASSETS',
          html_handling,
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*', '/s', '/s/*'],
        },
      }),
    );
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'dev',
        '--local',
        '--config',
        config,
        '--port',
        String(port),
        '--persist-to',
        join(temporary, `state-${port}`),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    let log = '';
    child.stdout.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-4000);
    });
    child.stderr.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-4000);
    });
    children.push(child);
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) break;
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/`)).ok;
      } catch {
        /* starting */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      children.forEach((child) => child.kill('SIGTERM'));
      throw new Error(`Cloudflare assets fixture failed: ${log}`);
    }
  }
  return async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
          }),
      ),
    );
  };
}
