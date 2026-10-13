import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatInput, ProviderConfig } from '../shared/types';
import { normalizeBaseUrl } from './provider-config';
import { GenerationCancelled, ProviderError } from './generation-errors';

export { GenerationCancelled, ProviderError } from './generation-errors';

function languageModel(config: ProviderConfig, fetch: typeof globalThis.fetch): LanguageModelV4 {
  let baseURL: string;
  try { baseURL = normalizeBaseUrl(config.baseUrl); }
  catch (error) { throw new ProviderError(error instanceof Error ? error.message : '供应商地址无效。'); }
  const options = { baseURL, apiKey: config.apiKey, fetch };
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

export async function openProviderStream(config: ProviderConfig, context: ChatInput[], signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (!config.apiKey) throw new ProviderError('尚未配置供应商 API 密钥。');
  let prepared: { input: Parameters<typeof fetch>[0]; init?: RequestInit } | undefined;
  // Use the SDK to construct the request, without giving its parser the live supplier body.
  const capture: typeof fetch = async (input, init) => {
    if (prepared) throw new Error('Unexpected second provider request');
    prepared = { input, init };
    return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const compatible = config.provider === 'openai-chat' && new URL(config.baseUrl).hostname !== 'api.openai.com';
    const deepseek = compatible && new URL(config.baseUrl).hostname === 'api.deepseek.com';
    const effort = config.reasoningEnabled ? config.reasoningEffort : undefined;
    const prompt: LanguageModelV4Prompt = [
      ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
      ...context.map((message) => message.role === 'system' ? { role: message.role, content: message.content }
        : { role: message.role, content: [{ type: 'text' as const, text: message.content }] }),
    ];
    const options: LanguageModelV4CallOptions = {
      prompt,
      maxOutputTokens: config.maxOutputTokens ?? undefined,
      reasoning: deepseek ? undefined : effort,
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
      abortSignal: signal,
    };
    const placeholder = await languageModel(config, capture).doStream(options);
    const reader = placeholder.stream.getReader();
    try { while (!(await reader.read()).done) { /* Empty local response, never the supplier stream. */ } }
    finally { reader.releaseLock(); }
    if (!prepared) throw new Error('Missing provider request');
    const response = await globalThis.fetch(prepared.input, { ...prepared.init, signal, redirect: 'manual' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(`模型供应商返回 HTTP ${response.status}，请检查密钥、模型和额度。`);
    }
    if (!response.body || !response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('模型供应商未返回有效的流式响应。');
    }
    return response.body;
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (signal.aborted) throw new ProviderError('模型供应商连接已中断。');
    throw new ProviderError('无法连接模型供应商，请检查服务地址和网络。');
  }
}
