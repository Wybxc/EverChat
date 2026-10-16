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
    assert.match(reloadBlocked(), /设置尚未保存/);
    await assert.rejects(save.flush());
    assert.match(reloadBlocked(), /设置尚未保存/);
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
  assert.match(reloadBlocked(), /云端修改/);
  first(true); // A late duplicate callback cannot change its outcome.
  second(false);
  assert.match(reloadBlocked(), /尚未确认/);
  beginWrite('PUT:another')(true);
  assert.match(reloadBlocked(), /尚未确认/);
  beginWrite('PUT:settings')(true);
  assert.equal(reloadBlocked(), '');
  setReloadLock(true);
  try {
    assert.throws(() => beginWrite('POST:new'), /正在更新/);
  } finally {
    setReloadLock(false);
  }
});
