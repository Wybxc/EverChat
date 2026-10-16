import * as v from 'valibot';
import type { ConversationSettings } from './types';
import type { ProviderConfig } from '../providers/types';
import { validateOutputLimit } from '../models/metadata';
import { WEB_TOOL_NAMES } from '../web-tools/tasks';

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  systemPrompt: null,
  temperature: null,
  topP: null,
  useGlobalMaxOutputTokens: true,
  maxOutputTokens: null,
  recentMessages: null,
  contextBudget: null,
  useSummaries: true,
  tools: [],
  autoCompression: { enabled: false, threshold: 80, model: null },
};
export const conversationSettingsSchema = v.pipe(
  v.strictObject({
    systemPrompt: v.nullable(v.pipe(v.string(), v.maxLength(20_000))),
    temperature: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2))),
    topP: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
    useGlobalMaxOutputTokens: v.boolean(),
    maxOutputTokens: v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
    ),
    recentMessages: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    contextBudget: v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000)),
    ),
    useSummaries: v.boolean(),
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
  v.check(
    (settings) => !settings.autoCompression.enabled || settings.useSummaries,
    '自动压缩需要启用历史摘要。',
  ),
);

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
    throw new Error(`当前模型的 Temperature 不能超过 ${support.temperatureMax}。`);
  if (topP !== undefined && topP < support.topPMin!)
    throw new Error(`当前模型的 Top P 不能低于 ${support.topPMin}。`);
  if (support.exclusive && temperature !== undefined && topP !== undefined)
    throw new Error('当前模型的 Temperature 和 Top P 只能设置一项。');
  return {
    ...config,
    systemPrompt: settings.systemPrompt ?? config.systemPrompt,
    maxOutputTokens,
    temperature,
    topP,
  };
}
