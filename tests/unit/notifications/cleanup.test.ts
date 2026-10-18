import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearLocal, registerNotificationCleanup } from '../../../src/platform/storage';

test('notification cleanup failure does not prevent clearing private drafts on logout', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values: Record<string, unknown> = {
    'everchat:draft': 'private draft',
    unrelated: 'keep',
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      ...values,
      removeItem(key: string) {
        Reflect.deleteProperty(this, key);
      },
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  registerNotificationCleanup(async () => {
    throw new Error('Notification DB unavailable');
  });
  await assert.rejects(clearLocal(), /未能完全清除/);
  assert.equal(Reflect.get(localStorage, 'everchat:draft'), undefined);
  assert.equal(Reflect.get(localStorage, 'unrelated'), 'keep');
});
