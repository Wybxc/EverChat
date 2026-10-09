import type { ChatInput } from '../shared/types';
import type { Env } from './env';

export class ProviderError extends Error {}
export class GenerationCancelled extends Error {}

// Parse SSE by frames, not network chunks (UTF-8 and JSON may both be fragmented).
export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new ProviderError('供应商返回了过大的流式事件。');
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index! + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.trim()) throw new ProviderError('供应商的回答流意外结束，已保存部分内容。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

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
  const base = new URL(env.AI_BASE_URL.replace(/\/$/, '') + '/chat/completions');
  if (base.protocol !== 'https:') throw new ProviderError('供应商地址必须使用 HTTPS。');
  let response: Response;
  try {
    response = await fetch(base, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model: env.AI_MODEL, stream: true,
        max_tokens: Number(env.MAX_OUTPUT_TOKENS) || 4096,
        messages: [{ role: 'system', content: env.SYSTEM_PROMPT }, ...context],
      }),
    });
  } catch { throw new ProviderError('无法连接模型供应商，请检查服务地址和网络。'); }
  // Never expose provider response bodies: they can contain credentials or private diagnostics.
  if (!response.ok) throw new ProviderError(`模型供应商返回 HTTP ${response.status}，请检查密钥、模型和额度。`);
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new ProviderError('模型供应商未返回兼容的 SSE 回答流。');
  let finished = false;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') { finished = true; break; }
    let event: { error?: unknown; choices?: { delta?: { content?: string }; finish_reason?: string | null }[] };
    try { event = JSON.parse(data); } catch { throw new ProviderError('模型供应商返回了无效的流式数据。'); }
    if (event.error) throw new ProviderError('模型供应商在生成期间返回错误。已保存部分内容。');
    const choice = event.choices?.[0];
    if (choice?.delta?.content) await onDelta(choice.delta.content);
    if (choice?.finish_reason) finished = true;
  }
  if (!finished) throw new ProviderError('与模型供应商的连接提前结束。已保存部分内容，请主动重新生成。');
}
