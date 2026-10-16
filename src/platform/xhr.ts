import { ApiError } from './api';
import { authSignal, networkIdentity, notifyAuthFailure } from './auth';

export function authenticatedUploadSignal(signal: AbortSignal) {
  if (!networkIdentity())
    throw new ApiError(503, '请先恢复连接并确认访问身份。', 'AUTH_UNAVAILABLE');
  return AbortSignal.any([signal, authSignal()]);
}
export function xhrJson(xhr: XMLHttpRequest, fallback: string): unknown {
  let body: { error?: string; code?: string } = {};
  try {
    body = JSON.parse(xhr.responseText);
  } catch {
    /* Edge errors may be HTML. */
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    notifyAuthFailure(xhr.status, body.code);
    throw new ApiError(
      xhr.status,
      typeof body.error === 'string' ? body.error : fallback,
      body.code,
    );
  }
  if (!xhr.getResponseHeader('Content-Type')?.includes('application/json'))
    throw new Error('云端响应格式无效。');
  return body;
}
