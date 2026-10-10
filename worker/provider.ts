import { APICallError, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatInput } from '../shared/types';
import type { Env } from './env';

export class ProviderError extends Error {}
export class GenerationCancelled extends Error {}

export async function generate(env: Env, context: ChatInput[], onDelta: (delta: string) => Promise<void>, signal: AbortSignal) {
  if (env.AI_PROVIDER === 'demo') {
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
  if (env.AI_PROVIDER !== 'openai-compatible') throw new ProviderError('AI_PROVIDER 配置无效。');
  if (!env.AI_API_KEY) throw new ProviderError('尚未配置供应商 API 密钥。');
  const base = new URL(env.AI_BASE_URL);
  if (base.protocol !== 'https:') throw new ProviderError('供应商地址必须使用 HTTPS。');
  try {
    const provider = createOpenAICompatible({ name: env.AI_PROVIDER, baseURL: base.toString().replace(/\/$/, ''), apiKey: env.AI_API_KEY });
    const result = streamText({
      model: provider.chatModel(env.AI_MODEL),
      system: env.SYSTEM_PROMPT,
      messages: context,
      maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS) || 4096,
      maxRetries: 0,
      streamRetries: 0,
      abortSignal: signal,
      onError: () => {},
    });
    let finished = false;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') await onDelta(part.text);
      else if (part.type === 'finish') finished = true;
      else if (part.type === 'error') {
        if (APICallError.isInstance(part.error) && part.error.statusCode) throw new ProviderError(`模型供应商返回 HTTP ${part.error.statusCode}，请检查密钥、模型和额度。`);
        throw new ProviderError('模型供应商在生成期间返回错误。已保存部分内容。');
      }
    }
    if (!finished) throw new ProviderError('与模型供应商的连接提前结束。已保存部分内容，请主动重新生成。');
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (APICallError.isInstance(error) && error.statusCode) throw new ProviderError(`模型供应商返回 HTTP ${error.statusCode}，请检查密钥、模型和额度。`);
    if (signal.aborted) throw new ProviderError('模型供应商连接已中断。');
    throw new ProviderError('无法连接模型供应商，请检查服务地址和网络。');
  }
}
