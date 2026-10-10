import * as v from 'valibot';
import type { ProviderConfig, ProviderKind, ProviderSettings } from '../shared/types';
import { providerOptions } from '../shared/providers';
import type { Env } from './env';

export const providerKinds: ProviderKind[] = providerOptions.map((option) => option.value);
export const providerConfigSchema = v.object({
  provider: v.picklist(providerKinds),
  baseUrl: v.pipe(v.string(), v.trim(), v.maxLength(2048)),
  model: v.pipe(v.string(), v.trim(), v.maxLength(200)),
  systemPrompt: v.pipe(v.string(), v.maxLength(20_000)),
  maxOutputTokens: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  apiKey: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4096))),
});

export function normalizeProvider(value: string | undefined): ProviderKind {
  if (value === 'openai-compatible') return 'openai-chat';
  if (!value) return 'demo';
  if (providerKinds.includes(value as ProviderKind)) return value as ProviderKind;
  throw new Error('AI_PROVIDER 配置无效。');
}

export function providerConfigFromEnv(env: Env): ProviderConfig {
  const provider = normalizeProvider(env.AI_PROVIDER);
  const defaults = providerOptions.find((option) => option.value === provider)!;
  const maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS);
  return {
    provider,
    baseUrl: env.AI_BASE_URL?.trim().replace(/\/+$/, '') || defaults.baseUrl,
    model: provider === 'demo' ? '演示模型' : env.AI_MODEL?.trim() || '',
    systemPrompt: env.SYSTEM_PROMPT ?? '你是一位清晰、友善的助手。请默认使用中文回答。',
    maxOutputTokens: Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 4096,
    apiKey: env.AI_API_KEY?.trim() || undefined,
  };
}

export function publicProviderSettings(config: ProviderConfig): ProviderSettings {
  return {
    provider: config.provider, baseUrl: config.baseUrl, model: config.model,
    systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens,
    hasApiKey: Boolean(config.apiKey),
  };
}

export function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('供应商地址无效。'); }
  if (url.protocol !== 'https:') throw new Error('供应商地址必须使用 HTTPS。');
  if (url.username || url.password || url.search || url.hash) throw new Error('供应商地址不能包含账号、查询参数或片段。');
  if (/\/(chat\/completions|responses|messages)$/.test(url.pathname) || url.pathname.includes(':streamGenerateContent')) {
    throw new Error('请填写 API 基础地址，包含版本路径，不包含具体接口路径。');
  }
  return baseUrl;
}

export function mergeProviderConfig(current: ProviderConfig, input: ProviderConfig): ProviderConfig {
  const parsed = v.safeParse(providerConfigSchema, input);
  if (!parsed.success) throw new Error('供应商配置无效，请检查字段和输出上限。');
  const config = parsed.output;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const sameEndpoint = config.provider === current.provider && baseUrl === current.baseUrl.replace(/\/+$/, '');
  const apiKey = config.provider === 'demo' ? undefined : config.apiKey || (sameEndpoint ? current.apiKey : undefined);
  if (apiKey && /[\r\n]/.test(apiKey)) throw new Error('API 密钥不能包含换行。');
  if (config.provider !== 'demo' && !config.model) throw new Error('请填写模型 ID。');
  if (config.provider !== 'demo' && !apiKey) throw new Error('请填写 API 密钥；更换协议或地址后需要重新填写。');
  return { ...config, baseUrl, model: config.provider === 'demo' ? '演示模型' : config.model, apiKey };
}
