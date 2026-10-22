import { MAX_BUFFERED_BODY_BYTES } from '../../shared/platform/limits';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import { AppError, problem } from '../../shared/errors/descriptor';
import { MAX_MODEL_TOKENS, reasoningEfforts } from '../../shared/models/metadata';
import type { DiscoveredModel, ModelMetadata } from '../../shared/models/types';
import type { ProviderFailure } from '../../shared/providers/failure';
import type { ProviderModelConfig } from '../../shared/providers/types';
import { providerIssue } from '../generation/errors';
import { normalizeBaseUrl } from './config';
import { httpProviderError, providerFailure } from './failure';

const diagnosticConfig = (profile: ProviderModelConfig) => ({
  ...profile,
  providerId: profile.id,
  providerName: profile.name,
  model: '',
  systemPrompt: '',
  maxOutputTokens: null,
});

export class ProviderModelError extends AppError {
  constructor(
    message: string,
    public status = 400,
    readonly details?: ProviderFailure,
  ) {
    super(details ? providerIssue(details) : problem('PROVIDER_CATALOG_INVALID'), message);
  }
}

function modelsEndpoint(profile: ProviderModelConfig): URL {
  const url = new URL(normalizeBaseUrl(profile.baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  if (profile.provider === 'gemini') url.searchParams.set('pageSize', '1000');
  if (profile.provider === 'anthropic') url.searchParams.set('limit', '1000');
  return url;
}

async function fetchPage(
  profile: ProviderModelConfig,
  url: URL,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers = new Headers({ Accept: 'application/json' });
  if (profile.provider === 'anthropic') {
    headers.set('x-api-key', profile.apiKey ?? '');
    headers.set('anthropic-version', '2023-06-01');
  } else if (profile.provider === 'gemini') headers.set('x-goog-api-key', profile.apiKey ?? '');
  else headers.set('Authorization', `Bearer ${profile.apiKey ?? ''}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  } catch {
    throw new ProviderModelError(
      '无法连接供应商，请检查 API 地址和网络。',
      502,
      providerFailure(diagnosticConfig(profile), 'connect'),
    );
  }
  if (!response.ok) {
    const error = await httpProviderError(response, diagnosticConfig(profile));
    throw new ProviderModelError(error.message, 502, error.details);
  }
  try {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let size = 0,
      text = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BUFFERED_BODY_BYTES)
          throw new ProviderModelError(
            '供应商模型目录超过获取大小保护，请手动添加需要的模型。',
            502,
          );
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderModelError) throw error;
    throw new ProviderModelError('供应商返回了无法识别的模型列表。', 502);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function reportedMetadata(
  profile: ProviderModelConfig,
  item: Record<string, unknown>,
): Partial<ModelMetadata> | undefined {
  const metadata: Partial<ModelMetadata> = {};
  const positiveLimit = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MODEL_TOKENS;
  const input =
    profile.provider === 'gemini'
      ? item.inputTokenLimit
      : profile.provider === 'anthropic'
        ? item.max_input_tokens
        : undefined;
  const output =
    profile.provider === 'gemini'
      ? item.outputTokenLimit
      : profile.provider === 'anthropic'
        ? item.max_tokens
        : undefined;
  if (positiveLimit(input)) {
    metadata.contextWindow = input;
    metadata.contextScope = 'input';
  }
  if (positiveLimit(output)) metadata.maxOutputTokens = output;
  if (profile.provider === 'gemini' && typeof item.thinking === 'boolean')
    metadata.reasoning = item.thinking;
  if (profile.provider === 'anthropic') {
    const capabilities = record(item.capabilities);
    for (const [field, native] of [
      ['imageInput', 'image_input'],
      ['structuredOutput', 'structured_outputs'],
      ['reasoning', 'thinking'],
    ] as const) {
      const supported = record(capabilities[native]).supported;
      if (typeof supported === 'boolean') metadata[field] = supported;
    }
    const effort = record(capabilities.effort);
    if (typeof effort.supported === 'boolean')
      metadata.reasoningEfforts = effort.supported
        ? reasoningEfforts.filter((level) => record(effort[level]).supported === true)
        : [];
    // server_tools advertises hosted search/code execution, not client function calling.
  }
  return Object.keys(metadata).length ? metadata : undefined;
}
function modelEntries(
  profile: ProviderModelConfig,
  response: Record<string, unknown>,
): DiscoveredModel[] {
  const data = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.models)
      ? response.models
      : [];
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const rawId =
      typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
    const id = profile.provider === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
    if (!/^[\w./:-]{1,200}$/.test(id)) return [];
    if (profile.provider === 'gemini') {
      const methods = item.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
    }
    const displayName =
      profile.provider === 'gemini'
        ? item.displayName
        : profile.provider === 'anthropic'
          ? item.display_name
          : undefined;
    const name =
      typeof displayName === 'string' && displayName.trim() && displayName.length <= 200
        ? displayName.trim()
        : id;
    const metadata = reportedMetadata(profile, item);
    return [{ id, name, ...(metadata ? { reportedMetadata: metadata } : {}) }];
  });
}

export async function fetchProviderModels(
  profile: ProviderModelConfig,
): Promise<DiscoveredModel[]> {
  if (!profile.apiKey) throw new ProviderModelError('请先配置 API 密钥。');
  const url = modelsEndpoint(profile);
  const found = new Map<string, DiscoveredModel>();
  let modelBytes = 2;
  let pageToken: string | undefined;
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(45_000);
  while (true) {
    signal.throwIfAborted();
    if (pageToken)
      url.searchParams.set(profile.provider === 'gemini' ? 'pageToken' : 'after_id', pageToken);
    const response = await fetchPage(profile, url, signal);
    for (const model of modelEntries(profile, response)) {
      if (!found.has(model.id)) {
        modelBytes += new TextEncoder().encode(JSON.stringify(model)).byteLength + 1;
        if (modelBytes > MAX_SQL_PAYLOAD_BYTES)
          throw new ProviderModelError(
            '模型目录超过单个供应商配置的数据库行大小，请拆分供应商或手动选择模型。',
            502,
          );
        found.set(model.id, model);
      }
    }
    const next =
      response.nextPageToken ?? (response.has_more === true ? response.last_id : undefined);
    if (response.has_more === true && (typeof next !== 'string' || !next))
      throw new ProviderModelError('供应商模型目录缺少下一页游标。', 502);
    if (next !== undefined && typeof next !== 'string')
      throw new ProviderModelError('供应商模型目录的分页游标无效。', 502);
    if (!next) break;
    if (seen.has(next))
      throw new ProviderModelError('供应商模型目录分页游标重复，请检查 API 端点。', 502);
    seen.add(next);
    pageToken = next;
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
