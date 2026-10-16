import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export interface MeasurementAccess {
  origin: string;
  headers: Record<string, string>;
}
export async function measurementAccess(path: string, origin: string): Promise<MeasurementAccess> {
  const value = JSON.parse(await readFile(path, 'utf8')) as {
    ACCESS_ORIGIN?: string;
    CF_ACCESS_CLIENT_ID?: string;
    CF_ACCESS_CLIENT_SECRET?: string;
  };
  assert.equal(
    value.ACCESS_ORIGIN,
    origin,
    'Access credentials must be bound to the exact validation origin',
  );
  assert.ok(
    value.CF_ACCESS_CLIENT_ID && value.CF_ACCESS_CLIENT_SECRET,
    'Access service credentials are required',
  );
  return {
    origin,
    headers: {
      'CF-Access-Client-Id': value.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': value.CF_ACCESS_CLIENT_SECRET,
    },
  };
}
