import { MAX_MODEL_TOKENS } from '../../../shared/models/metadata';
import { MAX_PROVIDER_MODELS } from '../../../shared/providers/limits';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../../../shared/conversation/limits';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderKind, ProviderSettingsInput } from '../../../shared/providers/types';
import type { Env } from '../../../worker/http/env';
import {
  defaultProviderSettings,
  mergeProviderSettings,
  providerConfigFromEnv,
  publicProviderSettings,
  runtimeProviderConfig,
} from '../../../worker/providers/config';

const profileId = '00000000-0000-4000-8000-000000000012';

const settings = {
  providers: [
    {
      id: profileId,
      name: 'Test',
      provider: 'openai-chat' as const,
      baseUrl: 'https://provider.example/v1',
      models: [{ id: 'test-model', name: '测试模型', enabled: true }],
      apiKey: 'private-key',
    },
  ],
  activeProviderId: profileId,
  activeModel: 'test-model',
  systemPrompt: 'system',
  maxOutputTokens: 128,
};

test('large model lists, prompts and explicit output limits share their new save bounds', () => {
  const models = [
    settings.providers[0].models[0],
    ...Array.from({ length: MAX_PROVIDER_MODELS - 1 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      enabled: false,
    })),
  ];
  const input = {
    ...settings,
    systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH),
    maxOutputTokens: 200_000,
    providers: [{ ...settings.providers[0], models }],
  };
  const saved = mergeProviderSettings(settings, input);
  assert.equal(saved.providers[0].models.length, MAX_PROVIDER_MODELS);
  assert.equal(saved.systemPrompt, input.systemPrompt);
  assert.equal(runtimeProviderConfig(saved)?.maxOutputTokens, 200_000);
  assert.throws(() =>
    mergeProviderSettings(settings, {
      ...input,
      providers: [
        {
          ...input.providers[0],
          models: [...models, { id: 'overflow', name: '', enabled: false }],
        },
      ],
    }),
  );
});

test('output limits default to unset while explicit configured limits remain available', () => {
  const env = {
    AI_PROVIDER: 'openai-chat',
    AI_MODEL: 'test-model',
    AI_API_KEY: 'private-key',
  } as Env;
  assert.equal(defaultProviderSettings({} as Env).maxOutputTokens, null);
  assert.equal(defaultProviderSettings(env).maxOutputTokens, null);
  assert.equal(providerConfigFromEnv(env)?.maxOutputTokens, null);
  assert.equal(
    defaultProviderSettings({ ...env, MAX_OUTPUT_TOKENS: '4096' }).maxOutputTokens,
    4096,
  );
  assert.equal(providerConfigFromEnv({ ...env, MAX_OUTPUT_TOKENS: '4096' })?.maxOutputTokens, 4096);
  assert.equal(
    runtimeProviderConfig(mergeProviderSettings(settings, { ...settings, maxOutputTokens: null }))
      ?.maxOutputTokens,
    null,
  );
  const { maxOutputTokens: _limit, ...omitted } = settings;
  assert.equal(mergeProviderSettings(settings, omitted).maxOutputTokens, null);
  assert.equal(mergeProviderSettings(settings, settings).maxOutputTokens, 128);
});

test('editing a provider retains its key across protocol and endpoint changes', () => {
  const blankKey = { ...settings, providers: [{ ...settings.providers[0], apiKey: '' }] };
  for (const patch of [
    {},
    { baseUrl: 'https://another.example/v1' },
    { provider: 'anthropic' as const },
    { provider: 'gemini' as const, baseUrl: 'https://another.example/v1' },
  ]) {
    const edited = mergeProviderSettings(settings, {
      ...blankKey,
      providers: [{ ...blankKey.providers[0], ...patch }],
    });
    assert.equal(edited.providers[0].apiKey, 'private-key');
    assert.equal(edited.activeProviderId, profileId);
    assert.equal(edited.activeModel, 'test-model');
    assert.deepEqual(
      edited.providers[0].models.map(
        ({
          reportedMetadata: _automatic,
          directoryMetadata: _directory,
          testedCapabilities: _tested,
          ...model
        }) => model,
      ),
      settings.providers[0].models,
    );
  }
  const replaced = mergeProviderSettings(settings, {
    ...settings,
    providers: [{ ...settings.providers[0], apiKey: 'replacement-key' }],
  });
  assert.equal(replaced.providers[0].apiKey, 'replacement-key');
  const newProfile = mergeProviderSettings(settings, {
    ...blankKey,
    activeProviderId: null,
    activeModel: '',
    providers: [{ ...blankKey.providers[0], id: crypto.randomUUID() }],
  });
  assert.equal(newProfile.providers[0].apiKey, undefined);
  assert.equal(publicProviderSettings(settings).providers[0].apiKey, 'private-key');
  assert.equal(publicProviderSettings(settings).providers[0].hasApiKey, true);
  assert.equal(
    providerConfigFromEnv({ AI_PROVIDER: 'openai-chat', AI_MODEL: 'env-model' } as Env)?.provider,
    'openai-chat',
  );
  assert.equal(
    runtimeProviderConfig({ ...settings, activeProviderId: null, activeModel: '' }),
    null,
  );
});

test('backup restore only retains keys for matching provider connections', () => {
  const blankKey = {
    ...settings,
    activeProviderId: null,
    activeModel: '',
    providers: [{ ...settings.providers[0], apiKey: '' }],
  };
  const options = { restoreModelMetadata: true, preserveKeysAcrossConnections: false };
  assert.equal(
    mergeProviderSettings(settings, blankKey, options).providers[0].apiKey,
    'private-key',
  );
  for (const patch of [
    { baseUrl: 'https://another.example/v1' },
    { provider: 'anthropic' as const },
  ]) {
    assert.equal(
      mergeProviderSettings(
        settings,
        { ...blankKey, providers: [{ ...blankKey.providers[0], ...patch }] },
        options,
      ).providers[0].apiKey,
      undefined,
    );
  }
});

test('provider names must contain non-whitespace characters', () => {
  for (const name of ['', '   ', '\t\n']) {
    assert.throws(
      () =>
        mergeProviderSettings(settings, {
          ...settings,
          providers: [{ ...settings.providers[0], name }],
        }),
      /请填写供应商名称/,
    );
  }
  const named = mergeProviderSettings(settings, {
    ...settings,
    providers: [{ ...settings.providers[0], name: '  我的供应商  ' }],
  });
  assert.equal(named.providers[0].name, '我的供应商');
});

test('missing model configuration cannot generate and unknown provider types are rejected', () => {
  assert.equal(providerConfigFromEnv({} as Env), null);
  assert.deepEqual(defaultProviderSettings({} as Env).providers, []);
  assert.throws(() => providerConfigFromEnv({ AI_PROVIDER: 'demo' } as Env), /AI_PROVIDER/);
  assert.throws(
    () => providerConfigFromEnv({ AI_PROVIDER: 'openai-compatible' } as Env),
    /AI_PROVIDER/,
  );
  assert.equal(
    runtimeProviderConfig({
      ...settings,
      providers: [{ ...settings.providers[0], apiKey: undefined }],
    }),
    null,
  );
  assert.equal(runtimeProviderConfig({ ...settings, activeModel: 'missing-model' }), null);
});

test('enabled model names survive persistence while disabled models cannot generate', () => {
  const disabled = {
    ...settings,
    providers: [
      {
        ...settings.providers[0],
        models: [{ id: 'test-model', name: '测试模型', enabled: false }],
      },
    ],
  };
  assert.throws(() => mergeProviderSettings(settings, disabled), /必须已启用/);
  assert.equal(runtimeProviderConfig(disabled), null);
  const saved = mergeProviderSettings(settings, settings);
  assert.equal(runtimeProviderConfig(saved)?.model, 'test-model');
  assert.equal(runtimeProviderConfig(saved)?.modelName, '测试模型');
  const blankName = {
    ...settings,
    providers: [
      { ...settings.providers[0], models: [{ id: 'test-model', name: '', enabled: true }] },
    ],
  };
  assert.equal(runtimeProviderConfig(blankName)?.modelName, 'test-model');
  assert.throws(
    () =>
      mergeProviderSettings(settings, {
        ...settings,
        providers: [{ ...settings.providers[0], models: ['test-model'] }],
      } as unknown as ProviderSettingsInput),
    /请检查/,
  );
});

test('provider profiles reject insecure endpoints, duplicate models and invalid limits', () => {
  for (const baseUrl of [
    'http://provider.example',
    'file:///tmp/key',
    'https://user:password@example.com',
    'https://example.com/v1?key=secret',
    'https://example.com/v1#secret',
    'https://example.com/v1/responses',
  ]) {
    assert.throws(() =>
      mergeProviderSettings(settings, {
        ...settings,
        providers: [{ ...settings.providers[0], baseUrl }],
      }),
    );
  }
  for (const maxOutputTokens of [0, -1, 0.5, MAX_MODEL_TOKENS + 1])
    assert.throws(() => mergeProviderSettings(settings, { ...settings, maxOutputTokens }));
  assert.throws(() =>
    mergeProviderSettings(settings, {
      ...settings,
      providers: [{ ...settings.providers[0], provider: 'invalid' as ProviderKind }],
    }),
  );
  assert.throws(() =>
    mergeProviderSettings(settings, {
      ...settings,
      providers: [{ ...settings.providers[0], apiKey: 'key\nheader' }],
    }),
  );
  assert.throws(() =>
    mergeProviderSettings(settings, {
      ...settings,
      providers: [
        {
          ...settings.providers[0],
          models: [
            { id: 'same', name: 'same', enabled: true },
            { id: 'same', name: 'same', enabled: true },
          ],
        },
      ],
    }),
  );
});

test('model overrides pin their prompt and validate provider reasoning support', () => {
  const custom = {
    ...settings,
    systemPrompt: '统一',
    providers: [
      {
        ...settings.providers[0],
        models: [
          {
            id: 'test-model',
            name: '测试模型',
            enabled: true,
            useGlobalSystemPrompt: false,
            systemPrompt: '专属',
            reasoningSupport: 'supported' as const,
          },
        ],
      },
    ],
  };
  assert.equal(runtimeProviderConfig(custom)?.systemPrompt, '专属');
  assert.equal(runtimeProviderConfig(custom)?.reasoningEffort, undefined);
  assert.equal(runtimeProviderConfig(custom, undefined, 'high')?.reasoningEffort, 'high');
  assert.equal(runtimeProviderConfig(custom, undefined, 'max'), null);
  const unknownField = {
    ...custom,
    providers: [
      {
        ...custom.providers[0],
        models: [{ ...custom.providers[0].models[0], reasoningEffort: 'high' }],
      },
    ],
  };
  assert.equal(
    Object.hasOwn(
      mergeProviderSettings(custom, unknownField).providers[0].models[0],
      'reasoningEffort',
    ),
    false,
  );
});
