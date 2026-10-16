import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderSettings, ProviderSettingsInput } from '../../../shared/providers/types';
import { SettingsAutosave } from '../../../src/features/providers/settings-autosave';
import { publicProviderSettings } from '../../../worker/providers/config';

const initial: ProviderSettings = {
  providers: [],
  activeProviderId: null,
  activeModel: '',
  systemPrompt: '',
  maxOutputTokens: 128,
  showReasoning: false,
};

test('autosave serializes requests and preserves edits made before an older response returns', async () => {
  let finishFirst!: (value: ProviderSettings) => void;
  const calls: ProviderSettingsInput[] = [];
  const saved: ProviderSettings[] = [];
  const store = new SettingsAutosave(
    initial,
    async (input) => {
      calls.push(input);
      if (calls.length === 1)
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      return publicProviderSettings(input);
    },
    (result) => saved.push(result),
    60_000,
  );
  try {
    store.update({ ...initial, systemPrompt: 'first' });
    const saving = store.flush();
    store.update({ ...initial, systemPrompt: 'latest', maxOutputTokens: 256 });
    assert.equal(store.flush(), saving);
    assert.equal(calls.length, 1);
    finishFirst(publicProviderSettings(calls[0]));
    await saving;
    assert.equal(calls.length, 2);
    assert.equal(calls[1].systemPrompt, 'latest');
    assert.equal(store.getSnapshot().settings.maxOutputTokens, 256);
    assert.equal(store.getSnapshot().status, 'saved');
    assert.equal(saved.at(-1)?.systemPrompt, 'latest');
  } finally {
    store.dispose();
  }
});

test('autosave keeps invalid drafts without replacing the saved configuration', async () => {
  let calls = 0;
  const store = new SettingsAutosave(
    initial,
    async (input) => {
      calls++;
      return publicProviderSettings(input);
    },
    () => {},
    60_000,
  );
  try {
    store.update({ ...initial, maxOutputTokens: 0 });
    await assert.rejects(store.flush());
    assert.equal(calls, 0);
    assert.equal(store.getSnapshot().status, 'error');
    assert.equal(store.getSnapshot().settings.maxOutputTokens, 0);
    store.update({ ...initial, maxOutputTokens: 512 });
    await store.flush();
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().status, 'saved');
  } finally {
    store.dispose();
  }
});

test('an unnamed provider stays in the draft until a nonblank name permits autosave', async () => {
  const calls: ProviderSettingsInput[] = [];
  const store = new SettingsAutosave(
    initial,
    async (input) => {
      calls.push(input);
      return publicProviderSettings(input);
    },
    () => {},
    60_000,
  );
  const profile = {
    id: crypto.randomUUID(),
    name: '',
    provider: 'openai-chat' as const,
    baseUrl: 'https://provider.test/v1',
    apiKey: 'test-key',
    hasApiKey: false,
    models: [{ id: 'custom-model', name: '自定义模型', enabled: true }],
  };
  try {
    for (const name of ['', '   ']) {
      store.update({ ...initial, providers: [{ ...profile, name }] });
      await assert.rejects(store.flush(), /请填写供应商名称/);
      assert.equal(calls.length, 0);
      assert.deepEqual(store.getSnapshot().settings.providers, [{ ...profile, name }]);
      assert.equal(store.getSnapshot().status, 'error');
    }
    store.update({
      ...store.getSnapshot().settings,
      providers: [{ ...profile, name: '  我的供应商  ' }],
    });
    await store.flush();
    assert.equal(calls.length, 1);
    const { hasApiKey: _flag, ...inputProfile } = profile;
    assert.deepEqual(calls[0].providers, [{ ...inputProfile, name: '我的供应商' }]);
    assert.equal(store.getSnapshot().status, 'saved');
  } finally {
    store.dispose();
  }
});

test('failed autosave retains the latest changes for retry', async () => {
  let fail = true;
  const store = new SettingsAutosave(
    initial,
    async (input) => {
      if (fail) throw new Error('Offline');
      return publicProviderSettings(input);
    },
    () => {},
    60_000,
  );
  try {
    store.update({ ...initial, systemPrompt: 'recover me' });
    await assert.rejects(store.flush(), /Offline/);
    assert.equal(store.getSnapshot().settings.systemPrompt, 'recover me');
    fail = false;
    await store.flush();
    assert.equal(store.getSnapshot().status, 'saved');
    assert.equal(store.getSnapshot().settings.systemPrompt, 'recover me');
  } finally {
    store.dispose();
  }
});

test('reopening refreshes remote settings without overwriting newer local edits', async () => {
  const store = new SettingsAutosave(
    initial,
    async (input) => publicProviderSettings(input),
    () => {},
    60_000,
  );
  try {
    await store.refresh(async () => ({ ...initial, systemPrompt: 'another device' }));
    assert.equal(store.getSnapshot().settings.systemPrompt, 'another device');
    let finishLoad!: (settings: ProviderSettings) => void;
    const refreshing = store.refresh(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    await Promise.resolve();
    store.update({ ...initial, systemPrompt: 'local draft' });
    finishLoad({ ...initial, systemPrompt: 'older remote snapshot' });
    await refreshing;
    assert.equal(store.getSnapshot().settings.systemPrompt, 'local draft');
    await store.flush();
    assert.equal(store.getSnapshot().settings.systemPrompt, 'local draft');
  } finally {
    store.dispose();
  }
});
