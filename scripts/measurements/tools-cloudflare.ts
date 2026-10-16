import { measurementAccess } from './support/credentials';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runToolValidation, type ToolValidationSuite } from './support/tool-platform-runner';
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    credentials: { type: 'string' },
    output: { type: 'string', default: '/tmp/everchat-tools-cloudflare.json' },
    suite: { type: 'string', default: 'functional' },
  },
});
assert.ok(values.url && values.credentials, '--url and --credentials are required');
const credentials = JSON.parse(await readFile(values.credentials, 'utf8')) as {
  VALIDATION_RUN_ID: string;
};
await runToolValidation({
  url: values.url,
  access: await measurementAccess(values.credentials!, new URL(values.url!).origin),
  runId: credentials.VALIDATION_RUN_ID,
  output: values.output!,
  suite: values.suite as ToolValidationSuite,
  runtime: 'cloudflare',
});
