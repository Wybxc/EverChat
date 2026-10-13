import type { ProviderModelConfig } from '../shared/types';
import { normalizeBaseUrl } from './provider-config';

export class ProviderModelError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function modelsEndpoint(profile: ProviderModelConfig): URL {
  const url = new URL(normalizeBaseUrl(profile.baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  if (profile.provider === 'gemini') url.searchParams.set('pageSize', '1000');
  if (profile.provider === 'anthropic') url.searchParams.set('limit', '1000');
  return url;
}

async function fetchPage(profile: ProviderModelConfig, url: URL): Promise<Record<string, unknown>> {
  const headers = new Headers({ Accept: 'application/json' });
  if (profile.provider === 'anthropic') {
    headers.set('x-api-key', profile.apiKey ?? '');
    headers.set('anthropic-version', '2023-06-01');
  } else if (profile.provider === 'gemini') headers.set('x-goog-api-key', profile.apiKey ?? '');
  else headers.set('Authorization', `Bearer ${profile.apiKey ?? ''}`);
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ProviderModelError('无法连接供应商，请检查 API 地址和网络。', 502);
  }
  if (!response.ok) throw new ProviderModelError(`供应商返回 HTTP ${response.status}，请检查密钥和权限。`, response.status >= 500 ? 502 : response.status);
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new ProviderModelError('供应商返回了无法识别的模型列表。', 502);
  }
}

function modelIds(profile: ProviderModelConfig, response: Record<string, unknown>): string[] {
  const data = Array.isArray(response.data) ? response.data : Array.isArray(response.models) ? response.models : [];
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
    if (!id) return [];
    if (profile.provider === 'gemini') {
      const methods = item.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
      return [id.replace(/^models\//, '')];
    }
    return [id];
  }).filter((id) => /^[\w./:-]{1,200}$/.test(id));
}

export async function fetchProviderModels(profile: ProviderModelConfig): Promise<string[]> {
  if (!profile.apiKey) throw new ProviderModelError('请先配置 API 密钥。');
  const url = modelsEndpoint(profile);
  const found = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5 && found.size < 200; page++) {
    if (pageToken) url.searchParams.set(profile.provider === 'gemini' ? 'pageToken' : 'after_id', pageToken);
    const response = await fetchPage(profile, url);
    for (const id of modelIds(profile, response)) {
      found.add(id);
      if (found.size >= 200) break;
    }
    const next = response.nextPageToken ?? (response.has_more === true ? response.last_id : undefined);
    if (typeof next !== 'string' || !next) break;
    pageToken = next;
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}
