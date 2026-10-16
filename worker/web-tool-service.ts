import type { WebToolServiceConfig } from '../shared/web-tools/service';
import { MAX_TOOL_SOURCE_CHARACTERS,MAX_TOOL_SOURCES,publicWebUrl,validateWebToolCall,validateWebToolOutcome,WEB_TOOL_NAMES,type WebToolCall,type WebToolOutcome } from '../shared/web-tools/tasks';

export const WEB_TOOL_RESPONSE_BYTES = 512 * 1024;
const WEB_TOOL_TIMEOUT_MS = 15_000;
export type WebToolFetch = (request: Request) => Promise<Response>;
const credentialsError = '联网服务密钥无效或没有访问权限。';
const quotaError = '联网服务的请求或用量额度已用尽。';
const timeoutError = '联网工具执行已停止或超过 15 秒期限。';
export function terminalWebToolError(outcome: WebToolOutcome): string | undefined {
  return outcome.status === 'failed' && [credentialsError, quotaError, timeoutError].includes(outcome.error) ? outcome.error : undefined;
}
const invalid = () => new Error('联网服务返回了无效或超限的结果。');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
function text(value: string, limit: number) {
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
  return /[\ud800-\udbff]$/.test(result) ? result.slice(0, -1) : result;
}
async function responseJson(response: Response, signal: AbortSignal) {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw invalid(); }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > WEB_TOOL_RESPONSE_BYTES)) { await response.body.cancel(); throw invalid(); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0, body = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      if ((size += next.value.byteLength) > WEB_TOOL_RESPONSE_BYTES) throw invalid();
      body += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(body + decoder.decode()));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function executeWebTool(config: WebToolServiceConfig, input: WebToolCall, signal: AbortSignal, fetcher: WebToolFetch = (request) => fetch(request)): Promise<WebToolOutcome> {
  const call = validateWebToolCall(input, WEB_TOOL_NAMES);
  const failed = (error: string): WebToolOutcome => ({ id: call.id, name: call.name, status: 'failed', error });
  if (config.provider !== 'tavily' || !config.apiKey || /[^\x21-\x7e]/.test(config.apiKey)) return failed('尚未配置联网工具服务。');
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, WEB_TOOL_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    const search = call.name === 'web_search';
    const body = search ? { query: call.input.query, topic: 'general', search_depth: 'basic', max_results: MAX_TOOL_SOURCES,
      auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_favicon: false }
      : { urls: [call.input.url], extract_depth: 'basic', format: 'text', timeout: 10, include_images: false, include_favicon: false };
    const response = await fetcher(new Request(`https://api.tavily.com/${search ? 'search' : 'extract'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), redirect: 'manual', signal: controller.signal,
    }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failed(response.status === 401 || response.status === 403 ? credentialsError
        : [429, 432, 433].includes(response.status) ? quotaError : '联网服务暂时不可用。');
    }
    if (response.redirected || response.url && response.url !== `https://api.tavily.com/${search ? 'search' : 'extract'}`) { await response.body?.cancel(); throw invalid(); }
    const data = await responseJson(response, controller.signal);
    if (!Array.isArray(data.results)) throw invalid();
    if (!search && (!Array.isArray(data.failed_results) || data.failed_results.length || data.results.length !== 1)) return failed('无法提取该网页的正文。');
    const sources: Extract<WebToolOutcome, { status: 'completed' }>['sources'] = [];
    let remaining = MAX_TOOL_SOURCE_CHARACTERS;
    for (const item of data.results.slice(0, search ? MAX_TOOL_SOURCES : 1)) {
      const row = object(item), content = search ? row.content : row.raw_content;
      if (typeof row.url !== 'string' || !publicWebUrl(row.url) || typeof content !== 'string' || search && typeof row.title !== 'string') throw invalid();
      const title = text(typeof row.title === 'string' ? row.title : new URL(row.url).hostname, 300) || new URL(row.url).hostname;
      const clean = text(content, content.length), truncated = clean.length > remaining;
      const notice = remaining >= 12 ? '\n[内容已截取]' : '…';
      const value = truncated ? text(clean, remaining - notice.length) + notice : clean; if (!value) continue;
      sources.push({ title, url: row.url, content: value }); remaining -= value.length; if (!remaining || truncated) break;
    }
    if (!search && !sources.length) return failed('该网页没有可读取的正文。');
    const outcome = validateWebToolOutcome({ id: call.id, name: call.name, status: 'completed', sources });
    if (outcome.status === 'completed' && outcome.sources.some((source) => [source.title, source.url, source.content].some((value) => value.includes(config.apiKey)))) throw invalid();
    return outcome;
  } catch {
    return failed(controller.signal.aborted ? timeoutError : '联网服务返回了无效结果或连接中断。');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
}
