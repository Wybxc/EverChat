import { APICallError, streamText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatInput, ProviderConfig } from '../shared/types';
import { normalizeBaseUrl } from './provider-config';
import { GenerationCancelled, ProviderError } from './generation-errors';

export { GenerationCancelled, ProviderError } from './generation-errors';

function responseReasoningDelta(value: unknown): { id: string; text: string } | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type !== 'response.reasoning_text.delta' || typeof event.delta !== 'string'
    || typeof event.item_id !== 'string' || typeof event.content_index !== 'number') return null;
  return { id: `${event.item_id}:${event.content_index}`, text: event.delta };
}

function languageModel(config: ProviderConfig): LanguageModel {
  let baseURL: string;
  try { baseURL = normalizeBaseUrl(config.baseUrl); }
  catch (error) { throw new ProviderError(error instanceof Error ? error.message : '供应商地址无效。'); }
  const options = { baseURL, apiKey: config.apiKey };
  switch (config.provider) {
    case 'openai-chat': return new URL(baseURL).hostname === 'api.openai.com'
      ? createOpenAI(options).chat(config.model)
      : createOpenAICompatible({ ...options, name: 'compatible' }).chatModel(config.model);
    case 'openai-responses': return createOpenAI(options).responses(config.model);
    case 'anthropic': return createAnthropic(options)(config.model);
    case 'gemini': return createGoogleGenerativeAI(options)(config.model);
    default: throw new ProviderError('AI_PROVIDER 配置无效。');
  }
}

export async function generate(config: ProviderConfig, context: ChatInput[], onDelta: (delta: string) => Promise<void>, signal: AbortSignal, onReasoning: (delta: string) => Promise<void> = async () => {}) {
  if (!config.apiKey) throw new ProviderError('尚未配置供应商 API 密钥。');
  try {
    const compatible = config.provider === 'openai-chat' && new URL(config.baseUrl).hostname !== 'api.openai.com';
    const deepseek = compatible && new URL(config.baseUrl).hostname === 'api.deepseek.com';
    const compatibleResponses = config.provider === 'openai-responses' && new URL(config.baseUrl).hostname !== 'api.openai.com';
    const effort = config.reasoningEnabled ? config.reasoningEffort : undefined;
    const abort = new AbortController();
    const result = streamText({
      model: languageModel(config),
      system: config.systemPrompt || undefined,
      messages: context,
      maxOutputTokens: config.maxOutputTokens ?? undefined,
      reasoning: deepseek ? undefined : effort,
      // Compatible Responses APIs can return reasoning_text instead of OpenAI's summaries.
      // Keep the SDK's SSE parser and expose the events it does not normalize yet.
      include: { rawChunks: compatibleResponses },
      providerOptions: compatible ? { compatible: {
        store: false,
      ...(deepseek && config.reasoningEnabled ? effort === 'none'
          ? { thinking: { type: 'disabled' } }
          : { thinking: { type: 'enabled' }, ...(effort ? { reasoningEffort: effort } : {}) } : {}),
      } } : config.provider.startsWith('openai-') ? { openai: {
        store: false,
        ...(config.reasoningEnabled && config.provider === 'openai-responses' ? { forceReasoning: true, reasoningSummary: 'auto' } : {}),
      } } : config.provider === 'anthropic' && config.reasoningEnabled && config.showReasoning
        ? { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, sendReasoning: true } }
        : config.provider === 'gemini' && config.reasoningEnabled
        ? { google: { thinkingConfig: { includeThoughts: true } } } : undefined,
      maxRetries: 0,
      streamRetries: 0,
      abortSignal: AbortSignal.any([signal, abort.signal]),
      onError: () => {},
    });
    let finished = false;
    let received = false;
    const rawReasoningParts = new Set<string>();
    try {
      for await (const part of result.fullStream.values({ preventCancel: true })) {
        if (part.type === 'text-delta') { received = true; await onDelta(part.text); }
        else if (part.type === 'raw' && compatibleResponses) {
          const delta = responseReasoningDelta(part.rawValue);
          if (delta) { rawReasoningParts.add(delta.id); await onReasoning(delta.text); }
        }
        // Raw events precede normalized deltas. Avoid duplicates if the SDK supports them later.
        else if (part.type === 'reasoning-delta' && !rawReasoningParts.has(part.id)) await onReasoning(part.text);
        else if (part.type === 'finish') {
          if (part.finishReason !== 'stop' && part.finishReason !== 'length') {
            throw new ProviderError('模型供应商未正常完成回答。已保存部分内容，请主动重新生成。');
          }
          finished = true;
        } else if (part.type === 'error') {
          if (APICallError.isInstance(part.error) && part.error.statusCode) throw new ProviderError(`模型供应商返回 HTTP ${part.error.statusCode}，请检查密钥、模型和额度。`);
          throw new ProviderError('模型供应商在生成期间返回错误。已保存部分内容。');
        }
      }
      if (!finished) throw new ProviderError('与模型供应商的连接提前结束。已保存部分内容，请主动重新生成。');
      if (!received) throw new ProviderError('模型供应商未返回文字回答。');
    } finally {
      // Abort upstream on checkpoint failure, then drain the SDK stream for clean teardown.
      // Cancelling its piped async iterator early can leave an unhandled rejection on Node.
      abort.abort();
      await result.consumeStream({ onError: () => {} });
    }
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (APICallError.isInstance(error) && error.statusCode) throw new ProviderError(`模型供应商返回 HTTP ${error.statusCode}，请检查密钥、模型和额度。`);
    if (signal.aborted) throw new ProviderError('模型供应商连接已中断。');
    throw new ProviderError('无法连接模型供应商，请检查服务地址和网络。');
  }
}
