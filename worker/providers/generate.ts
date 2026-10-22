import { generateText, type FinishReason, type ModelMessage } from 'ai';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import type { StreamUsage } from '../../shared/streaming/provider-stream';
import { coreUsage } from '../../shared/usage/normalize';
import { ProviderError } from '../generation/errors';
import { httpProviderError, providerFailure } from './failure';
import { boundedJsonResponse } from './response-body';
import { providerGenerationOptions, providerModel, providerRequestInit } from './sdk';
import { sdkProviderError } from './sdk-diagnostics';

export interface ProviderTextResult {
  text: string;
  finishReason: FinishReason;
  usage: StreamUsage;
  usageIsFinal: boolean;
}
export const AUXILIARY_RESPONSE_BYTES = 256 * 1024;

/** One bounded Core request for small internal text tasks, with no tool execution. */
export async function generateProviderText(
  config: ProviderConfig,
  context: ChatInput[],
  signal: AbortSignal,
  beforeRequest?: () => Promise<void>,
  onResponse?: (response: ProviderTextResult) => void,
): Promise<ProviderTextResult> {
  if (!config.apiKey)
    throw new ProviderError('尚未配置供应商 API 密钥。', providerFailure(config, 'connect'));
  const secrets = context.map((message) => message.content);
  let requested = false,
    headers: Headers | undefined;
  const request: typeof fetch = async (input, init) => {
    if (requested) throw new ProviderError('供应商请求不能重复发送。');
    requested = true;
    signal.throwIfAborted();
    await beforeRequest?.();
    signal.throwIfAborted();
    const response = await globalThis.fetch(input, {
      ...providerRequestInit(config, init),
      signal,
      redirect: 'manual',
    });
    headers = response.headers;
    if (!response.ok) throw await httpProviderError(response, config, secrets);
    return boundedJsonResponse(response, AUXILIARY_RESPONSE_BYTES, signal);
  };
  try {
    if (context.some((message) => message.images?.length || message.files?.length))
      throw new ProviderError('内部文本任务不接受附件。');
    const messages: ModelMessage[] = [
      ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
      ...context.map(({ role, content }) => ({ role, content })),
    ];
    const result = await generateText({
      model: providerModel(config, request),
      messages,
      allowSystemInMessages: true,
      maxRetries: 0,
      abortSignal: signal,
      ...providerGenerationOptions(config),
      telemetry: { isEnabled: false },
      onLanguageModelCallEnd(event) {
        onResponse?.({
          text: event.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
          finishReason: event.finishReason,
          usage: coreUsage(event.usage),
          usageIsFinal: true,
        });
      },
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: coreUsage(result.usage),
      usageIsFinal: true,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw sdkProviderError(error, config, 'connect', headers, secrets);
  }
}
