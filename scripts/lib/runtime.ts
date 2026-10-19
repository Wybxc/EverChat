import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/** Own the process and its disposable state together, including failed starts. */
export async function startLocalRuntime(options: {
  name: string;
  port: number;
  directory?: string;
  command?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const directory =
    options.directory ?? (await mkdtemp(join(tmpdir(), `everchat-${options.name}-`)));
  const child = spawn(
    process.execPath,
    options.command ?? [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(options.port),
      '--strictPort',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EVERCHAT_TEST_STATE: directory,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
        ...options.env,
      },
    },
  );
  let failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  // Wrangler may print bindings: drain output without retaining credentials in reports.
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const assertRunning = () => {
    if (failure) throw failure;
    assert.ok(child.exitCode === null && child.signalCode === null, 'Local runtime exited');
  };
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed;
        clearTimeout(force);
      }
      await rm(directory, { recursive: true, force: true });
    })());
  return {
    directory,
    child,
    assertRunning,
    async ready(check?: () => Promise<boolean>, timeout = 45_000) {
      const deadline = Date.now() + timeout;
      const probe =
        check ??
        (async () =>
          (
            await fetch(`http://127.0.0.1:${options.port}/`, {
              signal: AbortSignal.timeout(500),
              redirect: 'error',
            })
          ).ok);
      while (true) {
        assertRunning();
        let ready = false;
        try {
          ready = await probe();
        } catch {
          /* The listener may still be starting. */
        }
        if (ready) {
          assertRunning();
          return;
        }
        assert.ok(Date.now() < deadline, 'Local runtime startup timed out');
        await pause(200);
      }
    },
    stop,
  };
}
