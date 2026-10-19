import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { startLocalRuntime } from '../../../scripts/lib/runtime';
import { measurementApi } from '../../../scripts/measurements/support/client';

test('failed runtime startup is detected and disposable state is removed on repeated cleanup', async () => {
  const runtime = await startLocalRuntime({
    name: 'failed-start-test',
    port: 0,
    command: ['--eval', 'process.exit(7)'],
  });
  try {
    await assert.rejects(
      runtime.ready(async () => false, 2000),
      /Local runtime exited/,
    );
    assert.equal(runtime.child.exitCode, 7);
  } finally {
    await runtime.stop();
    await runtime.stop();
  }
  await assert.rejects(stat(runtime.directory), { code: 'ENOENT' });
});

test('measurement requests reject redirects and never include upstream bodies or credentials in errors', async () => {
  const original = globalThis.fetch;
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response('private-upstream-body', { status: 403 });
  };
  try {
    const { api } = measurementApi({
      origin: 'https://fixture.invalid',
      headers: () => ({ Authorization: 'Bearer private-key' }),
    });
    await assert.rejects(api('/fixture', { value: 1 }), (error: Error) => {
      assert.match(error.message, /POST \/fixture: HTTP 403/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
    assert.equal(captured?.url, 'https://fixture.invalid/api/fixture');
    assert.equal(captured?.init?.redirect, 'error');
    assert.equal(captured?.init?.body, '{"value":1}');
    assert.equal(new Headers(captured?.init?.headers).get('Origin'), 'https://fixture.invalid');
  } finally {
    globalThis.fetch = original;
  }
});
