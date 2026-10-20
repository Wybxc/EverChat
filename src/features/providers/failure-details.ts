import type { ProviderFailure } from '../../../shared/providers/failure';
import { t } from './locales';

const stages = {
  connect: 'stageConnect',
  response: 'stageResponse',
  stream: 'stageStream',
  protocol: 'stageProtocol',
  tool: 'stageTool',
  storage: 'stageStorage',
} as const;

/** Localize labels while preserving the sanitized provider diagnostics verbatim. */
export function failureEntries(failure: ProviderFailure): [string, string][] {
  return [
    [t(($) => $.failureStage), t(($) => $[stages[failure.stage]])],
    [t(($) => $.failureProvider), failure.providerName ?? failure.providerId],
    [t(($) => $.failureProtocol), failure.protocol],
    [
      t(($) => $.failureModel),
      failure.modelName && failure.model && failure.modelName !== failure.model
        ? `${failure.modelName} (${failure.model})`
        : failure.modelName || failure.model,
    ],
    [t(($) => $.failureEndpoint), failure.endpoint],
    ['HTTP', failure.status?.toString()],
    [t(($) => $.failureCode), failure.code],
    [t(($) => $.failureType), failure.type],
    [t(($) => $.failureMessage), failure.message],
    [t(($) => $.failureRequestId), failure.requestId],
    ['Retry-After', failure.retryAfter],
    [t(($) => $.failureTime), new Date(failure.occurredAt).toISOString()],
    [t(($) => $.failureTruncated), failure.truncated ? t(($) => $.truncatedDiagnostic) : undefined],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]));
}
export function failureDiagnosticText(summary: string, failure: ProviderFailure) {
  return [
    summary,
    ...failureEntries(failure).map(([label, value]) => `${label}: ${value}`),
    ...(failure.responseBody
      ? [`${t(($) => $.failureResponseBody)}:\n${failure.responseBody}`]
      : []),
  ].join('\n');
}
