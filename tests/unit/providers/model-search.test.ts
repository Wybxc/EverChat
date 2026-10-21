import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatModels, modelSelectionKey } from '../../../shared/models/selection';
import { groupModels, searchModels } from '../../../src/features/providers/model-search';

const models = chatModels({
  providers: [
    {
      id: 'direct',
      name: 'Direct',
      provider: 'openai-chat',
      baseUrl: 'https://provider.test',
      apiKey: 'test-key',
      models: [
        { id: 'model-alpha', name: 'Alpha', enabled: true },
        { id: 'model-beta', name: 'Beta', enabled: true },
      ],
    },
    {
      id: 'gateway',
      name: 'Gateway',
      provider: 'openai-chat',
      baseUrl: 'https://gateway.test',
      apiKey: 'test-key',
      models: [{ id: 'model-alpha', name: 'Alpha', enabled: true }],
    },
  ],
  activeProviderId: 'direct',
  activeModel: 'model-alpha',
  systemPrompt: '',
  maxOutputTokens: null,
});

test('model search matches display names, IDs, providers and non-contiguous fuzzy queries', () => {
  assert.deepEqual(searchModels(models, 'beta'), [models[1]]);
  assert.deepEqual(searchModels(models, 'model-beta'), [models[1]]);
  assert.deepEqual(searchModels(models, 'Gateway'), [models[2]]);
  assert.deepEqual(searchModels(models, 'mdlbt'), [models[1]]);
  assert.deepEqual(searchModels(models, 'no-such-model'), []);
});

test('empty model search preserves configured order and equal matches keep separate providers', () => {
  assert.deepEqual(searchModels(models, '   '), models);
  const matches = searchModels(models, 'Alpha');
  assert.deepEqual(matches, [models[0], models[2]]);
  assert.notEqual(modelSelectionKey(matches[0]), modelSelectionKey(matches[1]));
});

test('model groups retain ranked order, preserve provider identity and omit empty groups', () => {
  assert.deepEqual(groupModels([models[2], models[1], models[0]]), [
    { providerId: 'gateway', items: [models[2]] },
    { providerId: 'direct', items: [models[1], models[0]] },
  ]);
  assert.deepEqual(groupModels([]), []);
});
