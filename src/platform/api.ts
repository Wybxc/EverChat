import * as v from 'valibot';
import { readErrorIssue, type ErrorIssue } from '../../shared/errors/descriptor';
import { providerFailureSchema, type ProviderFailure } from '../../shared/providers/failure';
import { authFailure, authSignal, networkIdentity, notifyAuthFailure } from './auth';
import { UiError, issueMessage, uiMessage } from './i18n/messages';
import { beginWrite } from './pwa/reload-guard';
export { authFailure };
export class ApiError extends UiError {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public failure?: ProviderFailure,
    public issue?: ErrorIssue,
  ) {
    super(
      issue
        ? issueMessage(issue)
        : uiMessage(
            'errors',
            status === 401
              ? 'AUTH_REQUIRED'
              : status === 403
                ? 'ACCESS_DENIED'
                : status === 404
                  ? 'NOT_FOUND'
                  : status === 413
                    ? 'REQUEST_TOO_LARGE'
                    : status === 507
                      ? 'STORAGE_FULL'
                      : status >= 500
                        ? 'SERVICE_UNAVAILABLE'
                        : 'REQUEST_FAILED',
          ),
    );
    this.message = message;
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<T> {
  if (path !== '/session' && typeof window !== 'undefined' && !networkIdentity())
    throw new ApiError(503, 'Verify your identity before reconnecting.', 'AUTH_UNAVAILABLE');
  const finishWrite = method === 'GET' ? undefined : beginWrite(`${method}:${path}`);
  let confirmed = false;
  try {
    const rawBody = typeof Blob !== 'undefined' && body instanceof Blob;
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(body === undefined
          ? {}
          : {
              'Content-Type': rawBody
                ? body.type || 'application/octet-stream'
                : 'application/json',
            }),
      },
      body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(timeoutMs),
        ...(path !== '/session' ? [authSignal()] : []),
      ]),
    });
    let result: { error?: string; code?: string; failure?: unknown; issue?: unknown };
    try {
      result = await response.json();
    } catch {
      notifyAuthFailure(response.status);
      if (!response.ok) throw new ApiError(response.status, 'Cloud service unavailable.');
      throw new UiError(uiMessage('errors', 'INVALID_RESPONSE'));
    }
    if (!response.ok) {
      confirmed = response.status >= 400 && response.status < 500;
      notifyAuthFailure(response.status, result?.code);
      const details = v.safeParse(providerFailureSchema, result?.failure);
      throw new ApiError(
        response.status,
        typeof result?.error === 'string' ? result.error : 'Request failed.',
        typeof result?.code === 'string' ? result.code : undefined,
        details.success ? details.output : undefined,
        readErrorIssue(result?.issue),
      );
    }
    confirmed = true;
    return result as T;
  } finally {
    finishWrite?.(confirmed);
  }
}
