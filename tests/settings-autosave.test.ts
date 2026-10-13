import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsAutosave } from '../src/settings-autosave';
import { publicProviderSettings } from '../worker/provider-config';
import type { ProviderSettings, ProviderSettingsInput } from '../shared/types';

const initial: ProviderSettings = { providers: [], activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: 128 };

test('autosave serializes requests and preserves edits made before an older response returns', async () => {
  let finishFirst!: (value: ProviderSettings) => void;
  const calls: ProviderSettingsInput[] = [];
  const saved: ProviderSettings[] = [];
  const store = new SettingsAutosave(initial, async (input) => {
    calls.push(input);
    if (calls.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return publicProviderSettings(input);
  }, (result) => saved.push(result), 60_000);
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
  } finally { store.dispose(); }
});

test('autosave keeps invalid drafts without replacing the saved configuration', async () => {
  let calls = 0;
  const store = new SettingsAutosave(initial, async (input) => { calls++; return publicProviderSettings(input); }, () => {}, 60_000);
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
  } finally { store.dispose(); }
});

test('failed autosave retains the latest changes for retry', async () => {
  let fail = true;
  const store = new SettingsAutosave(initial, async (input) => {
    if (fail) throw new Error('Offline');
    return publicProviderSettings(input);
  }, () => {}, 60_000);
  try {
    store.update({ ...initial, systemPrompt: 'recover me' });
    await assert.rejects(store.flush(), /Offline/);
    assert.equal(store.getSnapshot().settings.systemPrompt, 'recover me');
    fail = false;
    await store.flush();
    assert.equal(store.getSnapshot().status, 'saved');
    assert.equal(store.getSnapshot().settings.systemPrompt, 'recover me');
  } finally { store.dispose(); }
});

test('reopening refreshes remote settings without overwriting newer local edits', async () => {
  const store = new SettingsAutosave(initial, async (input) => publicProviderSettings(input), () => {}, 60_000);
  try {
    await store.refresh(async () => ({ ...initial, systemPrompt: 'another device' }));
    assert.equal(store.getSnapshot().settings.systemPrompt, 'another device');
    let finishLoad!: (settings: ProviderSettings) => void;
    const refreshing = store.refresh(() => new Promise((resolve) => { finishLoad = resolve; }));
    await Promise.resolve();
    store.update({ ...initial, systemPrompt: 'local draft' });
    finishLoad({ ...initial, systemPrompt: 'older remote snapshot' });
    await refreshing;
    assert.equal(store.getSnapshot().settings.systemPrompt, 'local draft');
    await store.flush();
    assert.equal(store.getSnapshot().settings.systemPrompt, 'local draft');
  } finally { store.dispose(); }
});
