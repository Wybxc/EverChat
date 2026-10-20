import { execFile } from 'node:child_process';
import { cp, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

/** Two actual production bundles; preserve the caller's deployable dist directory. */
export async function preparePwaBuilds() {
  const root = await mkdtemp(join(tmpdir(), 'everchat-pwa-builds-'));
  const dist = resolve('dist'),
    saved = join(root, 'saved-dist');
  const existing = await stat(dist).then(
    () => true,
    () => false,
  );
  if (existing) await rename(dist, saved);
  try {
    for (const version of ['a', 'b']) {
      // Accept a preserved pre-change production bundle to exercise a real installed SW upgrade.
      if (version === 'a' && process.env.EVERCHAT_PWA_LEGACY_BUILD) {
        await cp(process.env.EVERCHAT_PWA_LEGACY_BUILD, join(root, version), { recursive: true });
        continue;
      }
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [resolve('node_modules/vite/bin/vite.js'), 'build'],
        {
          env: { ...process.env, EVERCHAT_BUILD_ID: `pwa-test-${version}` },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (!stdout.includes('injectManifest'))
        throw new Error(`Missing production SW build: ${stderr}`);
      await cp(resolve('dist/client'), join(root, version), { recursive: true });
    }
  } finally {
    await rm(dist, { recursive: true, force: true });
    if (existing) await rename(saved, dist);
  }
  return {
    a: join(root, 'a'),
    b: join(root, 'b'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
