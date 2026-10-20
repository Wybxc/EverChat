import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
  JSONParseError,
  TypeValidationError,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { ProviderConfig } from '../../shared/providers/types';
import type { ProviderFailure } from '../../shared/providers/failure';
import type { GenerationDiagnostics } from '../../shared/streaming/diagnostics';
import { ProviderError } from '../generation/errors';
import { providerFailure, providerErrorSummary, redactDiagnostic } from './failure';

export function sdkDiagnostics(
  part: Extract<LanguageModelV4StreamPart, { type: 'stream-start' | 'response-metadata' }>,
  config: ProviderConfig,
  secrets: readonly string[],
  headers?: Headers,
): GenerationDiagnostics {
  const clean = (value: string | undefined, limit: number) =>
    value === undefined
      ? undefined
      : redactDiagnostic(value, [config.apiKey ?? '', config.systemPrompt, ...secrets], limit);
  const requestId = clean(
    headers?.get('x-request-id') ??
      headers?.get('request-id') ??
      headers?.get('x-goog-request-id') ??
      undefined,
    200,
  );
  if (part.type === 'stream-start')
    return {
      ...(requestId ? { response: { requestId } } : {}),
      warnings: part.warnings.slice(0, 8).map((warning) => {
        // Never serialize a warning's arbitrary metadata or echoed request values.
        const label =
          warning.type === 'unsupported'
            ? warning.feature
            : warning.type === 'compatibility'
              ? warning.feature
              : warning.type === 'deprecated'
                ? warning.setting
                : undefined;
        return clean(
          [warning.type, label, 'message' in warning ? warning.message : warning.details]
            .filter(Boolean)
            .join(': '),
          512,
        )!;
      }),
    };
  const timestamp = part.timestamp?.getTime();
  return {
    warnings: [],
    response: {
      ...(requestId ? { requestId } : {}),
      id: clean(part.id, 200),
      model: clean(part.modelId, 200),
      ...(timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp >= 0
        ? { timestamp }
        : {}),
    },
  };
}

const protocolMessage = (error: unknown): string | undefined => {
  if (JSONParseError.isInstance(error)) return '供应商返回的 JSON 格式无效。';
  if (TypeValidationError.isInstance(error) || InvalidResponseDataError.isInstance(error))
    return '供应商响应不符合协议结构。';
  if (EmptyResponseBodyError.isInstance(error)) return '供应商返回了空响应。';
  if (UnsupportedFunctionalityError.isInstance(error))
    return `供应商适配器不支持：${error.functionality}`;
  if (NoSuchModelError.isInstance(error)) return '供应商适配器找不到所选模型。';
};

export function sdkProviderError(
  error: unknown,
  config: ProviderConfig,
  stage: ProviderFailure['stage'],
  headers?: Headers,
  secrets: readonly string[] = [],
): ProviderError {
  if (error instanceof ProviderError && error.details) return error;
  // Only SDK transport wrappers are unwrapped; validation errors can contain
  // response values and schema causes that must never be copied into a message.
  if (APICallError.isInstance(error)) {
    if (error.cause instanceof ProviderError && error.cause.details) return error.cause;
    if (error.statusCode !== undefined && (error.statusCode < 200 || error.statusCode >= 300))
      stage = 'response';
    else if (protocolMessage(error.cause) || error.statusCode !== undefined) stage = 'protocol';
    let value = error.data;
    // Some adapters omit parsed error data. Inspect only a small error body,
    // never a successful response or the SDK's requestBodyValues.
    if (value === undefined && error.responseBody && error.responseBody.length <= 16 * 1024) {
      try {
        value = JSON.parse(error.responseBody);
      } catch {
        /* Preserve the typed error and its bounded diagnostic body. */
      }
    }
    const failure = providerFailure(
      config,
      stage,
      value ?? {
        message:
          protocolMessage(error.cause) ??
          (error.cause instanceof Error ? error.cause.message : error.message),
      },
      {
        status: error.statusCode,
        headers:
          headers ?? (error.responseHeaders ? new Headers(error.responseHeaders) : undefined),
        responseBody: error.responseBody,
        secrets,
      },
    );
    return new ProviderError(
      stage === 'protocol'
        ? `供应商流格式无效或未完整结束：${failure.message ?? '连接中断'}。已保存部分内容。`
        : providerErrorSummary(failure),
      failure,
    );
  }
  const message = protocolMessage(error);
  const detail = message
    ? { message }
    : error instanceof Error
      ? { message: error.message }
      : error;
  const failure = providerFailure(config, message ? 'protocol' : stage, detail, {
    headers,
    secrets,
    responseBody:
      stage === 'stream' && !(error instanceof Error) ? JSON.stringify(error) : undefined,
  });
  return new ProviderError(
    stage === 'connect' && !message
      ? '无法连接模型供应商，请检查服务地址和网络。'
      : `供应商流格式无效或未完整结束：${failure.message ?? '连接中断'}。已保存部分内容。`,
    failure,
  );
}
