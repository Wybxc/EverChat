import { APICallError, streamText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatInput, ProviderConfig } from '../shared/types';
import { normalizeBaseUrl } from './provider-config';

export class ProviderError extends Error {}
export class GenerationCancelled extends Error {}

function languageModel(config: ProviderConfig): LanguageModel {
  let baseURL: string;
  try { baseURL = normalizeBaseUrl(config.baseUrl); }
  catch (error) { throw new ProviderError(error instanceof Error ? error.message : '供应商地址无效。'); }
  const options = { baseURL, apiKey: config.apiKey };
  switch (config.provider) {
    case 'openai-chat': return createOpenAI(options).chat(config.model);
    case 'openai-responses': return createOpenAI(options).responses(config.model);
    case 'anthropic': return createAnthropic(options)(config.model);
    case 'gemini': return createGoogleGenerativeAI(options)(config.model);
    default: throw new ProviderError('AI_PROVIDER 配置无效。');
  }
}

export async function generate(config: ProviderConfig, context: ChatInput[], onDelta: (delta: string) => Promise<void>, signal: AbortSignal) {
  if (config.provider === 'demo') {
    const prompt = context.at(-1)?.content ?? '';
    const reply = `这是 EverChat 的演示回答。你刚刚说：\n\n> ${prompt.replaceAll('\n', '\n> ')}\n\n` +
      '### 让对话，继续发生\n\n有时候，好的想法需要一点时间。你可以离开这个页面，切换设备，或者暂时断开网络。这个回答仍会在云端继续生成。\n\n' +
      '1. **放心离开**：生成任务已经被保存在云端，不依赖当前页面。\n2. **随时回来**：重新打开对话，就能看到已经保存的内容。\n3. **换端续聊**：用同一个密码登录另一台设备，对话会自动同步。\n\n' +
      '```text\n发送想法 → 云端生成 → 保存进度 → 随时继续\n```\n\n' +
      '这段演示会缓慢输出，方便你测试断网恢复和关闭页面后的生成。它用于验证同步体验；接入你自己的模型服务后，这里会变成真正的 AI 回答。\n\n' +
      '**现在，把注意力留给你的想法。其余的，交给 EverChat。**';
    for (let i = 0; i < reply.length; i += 10) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await onDelta(reply.slice(i, i + 10));
    }
    return;
  }
  if (!config.apiKey) throw new ProviderError('尚未配置供应商 API 密钥。');
  try {
    const result = streamText({
      model: languageModel(config),
      system: config.systemPrompt || undefined,
      messages: context,
      maxOutputTokens: config.maxOutputTokens,
      providerOptions: config.provider.startsWith('openai-') ? { openai: { store: false } } : undefined,
      maxRetries: 0,
      streamRetries: 0,
      abortSignal: signal,
      onError: () => {},
    });
    let finished = false;
    let received = false;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') { received = true; await onDelta(part.text); }
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
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (APICallError.isInstance(error) && error.statusCode) throw new ProviderError(`模型供应商返回 HTTP ${error.statusCode}，请检查密钥、模型和额度。`);
    if (signal.aborted) throw new ProviderError('模型供应商连接已中断。');
    throw new ProviderError('无法连接模型供应商，请检查服务地址和网络。');
  }
}
