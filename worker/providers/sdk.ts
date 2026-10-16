import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderConfig } from '../../shared/providers/types';
import { normalizeBaseUrl } from './config';
import { ProviderError } from '../generation/errors';

export function providerModel(
  config: ProviderConfig,
  fetch: typeof globalThis.fetch,
): LanguageModelV4 {
  let baseURL: string;
  try {
    baseURL = normalizeBaseUrl(config.baseUrl);
  } catch (error) {
    throw new ProviderError(error instanceof Error ? error.message : '供应商地址无效。');
  }
  const options = { baseURL, apiKey: config.apiKey, fetch };
  switch (config.provider) {
    case 'openai-chat':
      return new URL(baseURL).hostname === 'api.openai.com'
        ? createOpenAI(options).chat(config.model)
        : createOpenAICompatible({ ...options, name: 'compatible', includeUsage: true }).chatModel(
            config.model,
          );
    case 'openai-responses':
      return createOpenAI(options).responses(config.model);
    case 'anthropic':
      return createAnthropic(options)(config.model);
    case 'gemini':
      return createGoogleGenerativeAI(options)(config.model);
    default:
      throw new ProviderError('AI_PROVIDER 配置无效。');
  }
}

export function providerCallOptions(
  config: ProviderConfig,
  prompt: LanguageModelV4Prompt,
  signal: AbortSignal,
  tools?: LanguageModelV4CallOptions['tools'],
): LanguageModelV4CallOptions {
  const compatible =
    config.provider === 'openai-chat' && new URL(config.baseUrl).hostname !== 'api.openai.com';
  const deepseek = compatible && new URL(config.baseUrl).hostname === 'api.deepseek.com';
  // Recognizing thought output does not establish how to enable/control it.
  const controlReasoning =
    config.reasoningEnabled &&
    (!config.modelMetadata || config.modelMetadata.reasoningEfforts.length > 0);
  const effort = controlReasoning ? config.reasoningEffort : undefined;
  const toolMode = Boolean(tools?.length);
  return {
    prompt,
    tools,
    ...(toolMode ? { toolChoice: { type: 'auto' as const } } : {}),
    maxOutputTokens: config.maxOutputTokens ?? undefined,
    temperature: config.temperature,
    topP: config.topP,
    reasoning: deepseek ? undefined : effort,
    providerOptions: compatible
      ? {
          compatible: {
            store: false,
            ...(deepseek && controlReasoning
              ? effort === 'none'
                ? { thinking: { type: 'disabled' } }
                : { thinking: { type: 'enabled' }, ...(effort ? { reasoningEffort: effort } : {}) }
              : {}),
          },
        }
      : config.provider.startsWith('openai-')
        ? {
            openai: {
              store: false,
              ...(toolMode && config.provider === 'openai-responses'
                ? { include: ['reasoning.encrypted_content'] }
                : {}),
              ...(controlReasoning && config.provider === 'openai-responses'
                ? { forceReasoning: true, reasoningSummary: 'auto' }
                : {}),
            },
          }
        : config.provider === 'anthropic' &&
            (toolMode || (config.reasoningEnabled && config.showReasoning))
          ? {
              anthropic: {
                ...(controlReasoning
                  ? { thinking: { type: 'adaptive', display: 'summarized' } }
                  : {}),
                sendReasoning: true,
              },
            }
          : config.provider === 'gemini' && config.reasoningEnabled
            ? { google: { thinkingConfig: { includeThoughts: true } } }
            : undefined,
    abortSignal: signal,
  };
}
