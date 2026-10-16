import { authFailure, authSignal, networkIdentity, notifyAuthFailure } from './auth';
import * as v from 'valibot';
import { providerFailureSchema, type ProviderFailure } from '../../shared/providers/failure';
import { beginWrite } from './pwa/reload-guard';
export { authFailure };
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public failure?: ProviderFailure,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (path !== '/session' && typeof window !== 'undefined' && !networkIdentity())
    throw new ApiError(503, '请先恢复连接并确认访问身份。', 'AUTH_UNAVAILABLE');
  const finishWrite = method === 'GET' ? undefined : beginWrite(`${method}:${path}`);
  let confirmed = false;
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(20_000),
        ...(path !== '/session' ? [authSignal()] : []),
      ]),
    });
    let result: { error?: string; code?: string; failure?: unknown };
    try {
      result = await response.json();
    } catch {
      notifyAuthFailure(response.status);
      if (!response.ok) throw new ApiError(response.status, '云端服务暂时不可用，请稍后重试。');
      throw new Error('云端响应格式无效，请重新同步。');
    }
    if (!response.ok) {
      confirmed = response.status >= 400 && response.status < 500;
      notifyAuthFailure(response.status, result?.code);
      const details = v.safeParse(providerFailureSchema, result?.failure);
      throw new ApiError(
        response.status,
        typeof result?.error === 'string' ? result.error : '请求失败，请稍后重试。',
        typeof result?.code === 'string' ? result.code : undefined,
        details.success ? details.output : undefined,
      );
    }
    confirmed = true;
    return result as T;
  } finally {
    finishWrite?.(confirmed);
  }
}
