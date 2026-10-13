import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageErrorMessage, STORAGE_QUOTA_MESSAGE, DATABASE_LIMIT_MESSAGE } from '../worker/resource-limits';

test('storage quota errors are sanitized without reclassifying unrelated supplier or transport errors', () => {
  assert.equal(storageErrorMessage(new Error('SQLITE_FULL private diagnostic')), STORAGE_QUOTA_MESSAGE);
  assert.equal(storageErrorMessage(new Error('database or disk is full: opaque details')), STORAGE_QUOTA_MESSAGE);
  assert.equal(storageErrorMessage(new Error(DATABASE_LIMIT_MESSAGE)), DATABASE_LIMIT_MESSAGE);
  assert.equal(storageErrorMessage(new Error('Invalid supplier JSON')), null);
  assert.equal(storageErrorMessage(new Error('Connection reset')), null);
});
