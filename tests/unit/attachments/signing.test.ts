import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadSigner, r2UploadSigner } from '../../../worker/attachments/signing';
import type { Env } from '../../../worker/http/env';

const account = '1'.repeat(32);
const env = {
  R2_ACCOUNT_ID: account,
  R2_BUCKET_NAME: 'attachments',
  R2_ACCESS_KEY_ID: 'test-access',
  R2_SECRET_ACCESS_KEY: 'test-secret',
} as Env;

test('R2 signing fixes method, escaped object key and required headers without exposing the secret', async () => {
  const expiresAt = Date.now() + 300_000;
  const result = await r2UploadSigner(env)('attachments/空间/a b+#', 'text/plain', expiresAt);
  const url = new URL(result.url);
  assert.equal(url.origin, `https://${account}.r2.cloudflarestorage.com`);
  assert.equal(decodeURIComponent(url.pathname), '/attachments/attachments/空间/a b+#');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host;if-none-match');
  assert.ok(Number(url.searchParams.get('X-Amz-Expires')) <= 300);
  assert.deepEqual(result.headers, { 'Content-Type': 'text/plain', 'If-None-Match': '*' });
  assert.equal(result.method, 'PUT');
  assert.equal(result.expiresAt, expiresAt);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(url.searchParams.has('X-Amz-Content-Sha256'), false);
});

test('missing production S3 config fails explicitly and expired registrations cannot be resigned', async () => {
  for (const name of [
    'R2_ACCOUNT_ID',
    'R2_BUCKET_NAME',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ]) {
    assert.throws(() => r2UploadSigner({ ...env, [name]: '' }), { status: 503 });
  }
  assert.throws(() => r2UploadSigner({ ...env, R2_ACCOUNT_ID: 'foreign.invalid' }), {
    status: 503,
  });
  const sign = createUploadSigner({
    endpoint: 'https://r2.example',
    bucket: 'bucket',
    accessKeyId: 'test',
    secretAccessKey: 'secret',
  });
  await assert.rejects(sign('key', 'text/plain', Date.now() - 1), { status: 410 });
});
