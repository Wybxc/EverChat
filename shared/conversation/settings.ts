import * as v from 'valibot';
import { AppError, problem } from '../errors/descriptor';
import { MAX_MODEL_TOKENS, validateOutputLimit } from '../models/metadata';
import type { ProviderConfig } from '../providers/types';
import { WEB_TOOL_NAMES } from '../web-tools/tasks';
import { MAX_SYSTEM_PROMPT_LENGTH } from './limits';
import type { ConversationSettings } from './types';

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  systemPrompt: null,
  temperature: null,
  topP: null,
  useGlobalMaxOutputTokens: true,
  maxOutputTokens: null,
  recentMessages: null,
  contextBudget: null,
  tools: [],
  autoCompression: { enabled: false, threshold: 80, model: null },
};
export const conversationSettingsSchema = v.pipe(
  v.strictObject({
    systemPrompt: v.nullable(v.pipe(v.string(), v.maxLength(MAX_SYSTEM_PROMPT_LENGTH))),
    temperature: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2))),
    topP: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
    useGlobalMaxOutputTokens: v.boolean(),
    maxOutputTokens: v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_MODEL_TOKENS)),
    ),
    recentMessages: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    contextBudget: v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000)),
    ),
    tools: v.pipe(
      v.array(v.picklist(WEB_TOOL_NAMES)),
      v.maxLength(WEB_TOOL_NAMES.length),
      v.check((tools) => new Set(tools).size === tools.length),
    ),
    autoCompression: v.strictObject({
      enabled: v.boolean(),
      threshold: v.pipe(v.number(), v.integer(), v.minValue(50), v.maxValue(95)),
      model: v.nullable(
        v.strictObject({
          providerId: v.pipe(v.string(), v.uuid()),
          model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        }),
      ),
    }),
  }),
);

// Project saved values onto the current public settings. Retired fields stay
// untouched in storage until offline cleanup; reading settings never rewrites it.
export function conversationSettingsDefaults(
  value: Partial<ConversationSettings> = {},
): ConversationSettings {
  const entries = Object.entries(DEFAULT_CONVERSATION_SETTINGS);
  if (
    Object.keys(value).length === entries.length &&
    entries.every(([key]) => value[key as keyof ConversationSettings] !== undefined)
  )
    return value as ConversationSettings;
  return Object.fromEntries(
    entries.map(([key, fallback]) => [key, value[key as keyof ConversationSettings] ?? fallback]),
  ) as unknown as ConversationSettings;
}

// These gates also run on the server. Hidden settings remain available when switching back to a supported model.
export function samplingSupport(
  config: Pick<
    ProviderConfig,
    'provider' | 'baseUrl' | 'model' | 'reasoningEnabled' | 'reasoningEffort'
  >,
) {
  const id = config.model.toLowerCase();
  const none = config.reasoningEffort === 'none';
  if (new URL(config.baseUrl).hostname === 'api.deepseek.com') {
    if (config.provider === 'openai-responses' && config.reasoningEnabled)
      return { temperatureMax: null, topPMin: null, exclusive: false };
    const thinking = config.reasoningEnabled && !none;
    return {
      temperatureMax: thinking ? null : 2,
      topPMin: thinking ? 0.95 : null,
      exclusive: false,
    };
  }
  if (config.provider === 'anthropic') {
    const version = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/.exec(id);
    const removed =
      /^claude-(?:mythos|fable)/.test(id) ||
      Boolean(
        version &&
        (Number(version[1]) >= 5 || (Number(version[1]) === 4 && Number(version[2] ?? 0) >= 7)),
      );
    // The installed Anthropic SDK omits both sampling controls when thinking is enabled.
    const thinking = config.reasoningEnabled;
    return {
      temperatureMax: removed || thinking ? null : 1,
      topPMin: removed || thinking ? null : 0,
      exclusive: true,
    };
  }
  if (config.provider === 'gemini') {
    const version = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
    const removed = Boolean(
      version &&
      (Number(version[1]) >= 4 || (Number(version[1]) === 3 && Number(version[2] ?? 0) >= 6)),
    );
    return { temperatureMax: removed ? null : 2, topPMin: removed ? null : 0, exclusive: false };
  }
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  const reasoning =
    /^o[1-9](?:-|$)/.test(id) ||
    Boolean(gpt && Number(gpt[1]) >= 5 && !/^gpt-5-chat(?:-|$)/.test(id));
  const canDisable =
    Boolean(gpt && Number(gpt[1]) === 5 && Number(gpt[2] ?? 0) >= 1) ||
    /^gpt-6-(?:sol|luna)(?:-|$)/.test(id);
  const blocked =
    /search-preview(?:-|$)/.test(id) ||
    (reasoning ? !(canDisable && none) : Boolean(config.reasoningEnabled && !none));
  return { temperatureMax: blocked ? null : 2, topPMin: blocked ? null : 0, exclusive: false };
}

export function applyConversationSettings(
  config: ProviderConfig,
  settings: ConversationSettings,
): ProviderConfig {
  const maxOutputTokens = settings.useGlobalMaxOutputTokens
    ? config.maxOutputTokens
    : settings.maxOutputTokens;
  validateOutputLimit(config.modelMetadata, maxOutputTokens);
  const support = samplingSupport(config);
  const temperature =
    support.temperatureMax === null ? undefined : (settings.temperature ?? undefined);
  const topP = support.topPMin === null ? undefined : (settings.topP ?? undefined);
  if (temperature !== undefined && temperature > support.temperatureMax!)
    throw new AppError(
      problem('TEMPERATURE_EXCEEDED', { limit: support.temperatureMax! }),
      `当前模型的 Temperature 不能超过 ${support.temperatureMax}。`,
    );
  if (topP !== undefined && topP < support.topPMin!)
    throw new AppError(
      problem('TOP_P_BELOW_MINIMUM', { limit: support.topPMin! }),
      `当前模型的 Top P 不能低于 ${support.topPMin}。`,
    );
  if (support.exclusive && temperature !== undefined && topP !== undefined)
    throw new AppError(
      problem('SAMPLING_CONFLICT'),
      '当前模型的 Temperature 和 Top P 只能设置一项。',
    );
  return {
    ...config,
    systemPrompt: settings.systemPrompt ?? config.systemPrompt,
    maxOutputTokens,
    temperature,
    topP,
  };
}
