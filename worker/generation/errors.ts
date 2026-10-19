import { AppError, problem, type ErrorIssue } from '../../shared/errors/descriptor';
import type { ProviderFailure } from '../../shared/providers/failure';

export class ProviderError extends AppError {
  constructor(
    message: string,
    readonly details?: ProviderFailure,
    issue?: ErrorIssue,
  ) {
    super(issue ?? providerIssue(details), message);
    this.name = 'ProviderError';
  }
}
export class GenerationCancelled extends Error {}

export function providerIssue(details?: ProviderFailure): ErrorIssue {
  if (details?.stage === 'storage') return problem('STORAGE_FULL');
  if (details?.stage === 'connect') return problem('PROVIDER_CONNECTION_FAILED');
  if (details?.stage === 'tool') return problem('TOOL_FAILED');
  if (details?.stage === 'protocol') return problem('STREAM_INVALID');
  const status = details?.status;
  return status === 401 || status === 403
    ? problem('PROVIDER_UNAUTHORIZED')
    : status === 429
      ? problem('PROVIDER_RATE_LIMITED')
      : status === 404
        ? problem('PROVIDER_MODEL_NOT_FOUND')
        : status
          ? problem('PROVIDER_HTTP_ERROR', { status })
          : problem('PROVIDER_FAILED');
}
