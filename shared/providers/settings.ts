import * as v from 'valibot';
import { MAX_SQL_PAYLOAD_BYTES, MAX_SYSTEM_PROMPT_LENGTH } from '../conversation/limits';
import { titleSettingsSchema } from '../conversation/titles';
import { AppError, problem } from '../errors/descriptor';
import { MAX_MODEL_TOKENS, reasoningEfforts } from '../models/metadata';
import { providerOptions } from './endpoints';
import type { ProviderApiKind, ProviderSettingsInput } from './types';

export const providerTypes = providerOptions.map((option) => option.value) as [
  ProviderApiKind,
  ...ProviderApiKind[],
];
// SQLite limits a whole row to 2 MB; leave room for record headers and column encoding.
const MAX_PROVIDER_PROFILE_BYTES = 2_000_000 - 1024;
const modelId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const tokenLimit = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_MODEL_TOKENS));
const metadataFields = {
  contextWindow: v.optional(tokenLimit),
  contextScope: v.optional(v.picklist(['combined', 'input'])),
  maxOutputTokens: v.optional(tokenLimit),
  imageInput: v.optional(v.boolean()),
  toolCalls: v.optional(v.boolean()),
  structuredOutput: v.optional(v.boolean()),
  reasoningEfforts: v.optional(
    v.pipe(
      v.array(v.picklist(reasoningEfforts)),
      v.maxLength(reasoningEfforts.length),
      v.check((values) => new Set(values).size === values.length),
    ),
  ),
};
export const modelSchema = v.object({
  id: modelId,
  name: v.pipe(v.string(), v.trim(), v.maxLength(200)),
  enabled: v.boolean(),
  useGlobalSystemPrompt: v.optional(v.boolean()),
  systemPrompt: v.optional(v.pipe(v.string(), v.maxLength(MAX_SYSTEM_PROMPT_LENGTH))),
  reasoningSupport: v.optional(v.picklist(['auto', 'supported', 'unsupported'])),
  reportedMetadata: v.optional(
    v.strictObject({ ...metadataFields, reasoning: v.optional(v.boolean()) }),
  ),
  directoryMetadata: v.optional(
    v.strictObject({
      values: v.strictObject({ ...metadataFields, reasoning: v.optional(v.boolean()) }),
      match: v.picklist(['exact', 'alias']),
      updatedAt: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(Number.MAX_SAFE_INTEGER),
      ),
    }),
  ),
  testedCapabilities: v.optional(
    v.strictObject({
      imageInput: v.optional(v.literal(true)),
      toolCalls: v.optional(v.literal(true)),
      testedAt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
    }),
  ),
  metadataOverrides: v.optional(v.strictObject(metadataFields)),
});
const profileSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  provider: v.picklist(providerTypes),
  baseUrl: v.pipe(v.string(), v.trim(), v.maxLength(2048)),
  models: v.array(modelSchema),
  apiKey: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4096))),
});
export const providerSettingsSchema = v.pipe(
  v.object({
    title: v.optional(titleSettingsSchema),
    providers: v.array(profileSchema),
    activeProviderId: v.nullable(v.pipe(v.string(), v.uuid())),
    activeModel: v.pipe(v.string(), v.trim(), v.maxLength(200)),
    systemPrompt: v.pipe(v.string(), v.maxLength(MAX_SYSTEM_PROMPT_LENGTH)),
    maxOutputTokens: v.optional(
      v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_MODEL_TOKENS))),
      null,
    ),
  }),
  v.check(
    ({ systemPrompt, activeProviderId, activeModel, maxOutputTokens }) =>
      new TextEncoder().encode(
        JSON.stringify({ systemPrompt, activeProviderId, activeModel, maxOutputTokens }),
      ).byteLength <= MAX_SQL_PAYLOAD_BYTES,
    '默认供应商参数超过数据库单行存储大小。',
  ),
);

export function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError(problem('PROVIDER_URL_INVALID'), '供应商地址无效。');
  }
  if (url.protocol !== 'https:')
    throw new AppError(problem('PROVIDER_URL_INVALID'), '供应商地址必须使用 HTTPS。');
  if (url.username || url.password || url.search || url.hash)
    throw new AppError(problem('PROVIDER_URL_INVALID'), '供应商地址不能包含账号、查询参数或片段。');
  if (
    /\/(chat\/completions|responses|messages|models)$/.test(url.pathname) ||
    url.pathname.includes(':streamGenerateContent')
  ) {
    throw new AppError(
      problem('PROVIDER_URL_INVALID'),
      '请填写 API 基础地址，不包含具体接口路径。',
    );
  }
  return baseUrl;
}

export function mergeProviderSettings(
  current: ProviderSettingsInput,
  input: unknown,
  options: { restoreModelMetadata?: boolean; preserveKeysAcrossConnections?: boolean } = {},
): ProviderSettingsInput {
  const parsed = v.safeParse(providerSettingsSchema, input);
  if (!parsed.success) {
    if (
      parsed.issues.some(
        (issue) =>
          issue.path?.[0]?.key === 'providers' &&
          issue.path?.[2]?.key === 'name' &&
          typeof issue.input === 'string' &&
          !issue.input.trim(),
      )
    ) {
      throw new AppError(problem('PROVIDER_NAME_REQUIRED'), '请填写供应商名称。');
    }
    throw new AppError(
      problem('PROVIDER_INVALID'),
      '请检查名称、模型 ID 和 Token 限制（正整数）；模型能力配置无效。',
    );
  }
  const seenIds = new Set<string>();
  const providers = parsed.output.providers.map((profile) => {
    if (seenIds.has(profile.id))
      throw new AppError(problem('PROVIDER_INVALID'), '供应商 ID 不能重复。');
    seenIds.add(profile.id);
    const baseUrl = normalizeBaseUrl(profile.baseUrl);
    const existing = current.providers.find((item) => item.id === profile.id);
    const sameEndpoint = existing?.baseUrl.replace(/\/+$/, '') === baseUrl;
    const sameConnection = sameEndpoint && existing?.provider === profile.provider;
    const apiKey =
      profile.apiKey ||
      (sameConnection || options.preserveKeysAcrossConnections !== false
        ? existing?.apiKey
        : undefined);
    if (apiKey && /[\r\n]/.test(apiKey))
      throw new AppError(problem('PROVIDER_KEY_INVALID'), 'API 密钥不能包含换行。');
    if (new Set(profile.models.map((model) => model.id)).size !== profile.models.length)
      throw new AppError(problem('PROVIDER_INVALID'), '模型 ID 不能重复。');
    const models =
      existing && !options.restoreModelMetadata
        ? profile.models.map((model) =>
            !sameConnection
              ? {
                  ...model,
                  reportedMetadata: undefined,
                  directoryMetadata: undefined,
                  testedCapabilities: undefined,
                }
              : apiKey !== existing.apiKey
                ? { ...model, testedCapabilities: undefined }
                : model,
          )
        : profile.models;
    const merged = { ...profile, models, baseUrl, apiKey };
    if (new TextEncoder().encode(JSON.stringify(merged)).byteLength > MAX_PROVIDER_PROFILE_BYTES)
      throw new AppError(
        problem('PROVIDER_INVALID'),
        '单个供应商配置超过云端存储上限，请减少模型或系统提示词。',
      );
    return merged;
  });
  const settings = {
    ...parsed.output,
    providers,
  };
  if (settings.activeProviderId) {
    const active = providers.find((profile) => profile.id === settings.activeProviderId);
    if (
      !active?.apiKey ||
      !active.models.some((model) => model.id === settings.activeModel && model.enabled)
    ) {
      throw new AppError(
        problem('PROVIDER_INVALID'),
        '默认模型必须已启用，且供应商已配置 API 密钥。',
      );
    }
  } else if (settings.activeModel)
    throw new AppError(problem('PROVIDER_INVALID'), '请先选择默认供应商。');
  return settings;
}
