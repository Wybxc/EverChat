import { readErrorIssue } from '../../shared/errors/descriptor';
import { ApiError } from './api';
import { authSignal, networkIdentity, notifyAuthFailure } from './auth';
import { UiError, uiMessage } from './i18n/messages';

export function authenticatedUploadSignal(signal: AbortSignal) {
  if (!networkIdentity())
    throw new ApiError(503, 'Verify your identity before reconnecting.', 'AUTH_UNAVAILABLE');
  return AbortSignal.any([signal, authSignal()]);
}
export function xhrJson(xhr: XMLHttpRequest, fallback: string): unknown {
  let body: { error?: string; code?: string; issue?: unknown } = {};
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
      undefined,
      readErrorIssue(body.issue),
    );
  }
  if (!xhr.getResponseHeader('Content-Type')?.includes('application/json'))
    throw new UiError(uiMessage('errors', 'INVALID_RESPONSE'));
  return body;
}
