import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Autosave } from '../../../src/platform/autosave';
import { beginWrite, reloadBlocked, setReloadLock } from '../../../src/platform/pwa/reload-guard';

test('an invalid settings draft blocks update until a successful save or explicit disposal', async () => {
  let fail = true;
  const save = new Autosave(
    '',
    async (value: string) => {
      if (fail) throw new Error('Unavailable');
      return value;
    },
    () => {},
    (_, draft) => draft,
    60_000,
  );
  try {
    save.update('private unsaved key');
    assert.equal(reloadBlocked(), 'unsavedSettings');
    await assert.rejects(save.flush());
    assert.equal(reloadBlocked(), 'unsavedSettings');
    fail = false;
    await save.flush();
    assert.equal(reloadBlocked(), '');
    save.update('another unsaved value');
    save.dispose();
    assert.equal(reloadBlocked(), '');
  } finally {
    save.dispose();
  }
});

test('unknown cloud writes remain protected until the same operation is confirmed', () => {
  const first = beginWrite('PUT:settings');
  const second = beginWrite('PUT:settings');
  first(false);
  assert.equal(reloadBlocked(), 'cloudWrites');
  first(true); // A late duplicate callback cannot change its outcome.
  second(false);
  assert.equal(reloadBlocked(), 'unconfirmedWrites');
  beginWrite('PUT:another')(true);
  assert.equal(reloadBlocked(), 'unconfirmedWrites');
  beginWrite('PUT:settings')(true);
  assert.equal(reloadBlocked(), '');
  setReloadLock(true);
  try {
    assert.throws(() => beginWrite('POST:new'), /updating/);
  } finally {
    setReloadLock(false);
  }
});
