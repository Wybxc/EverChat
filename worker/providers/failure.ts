import type { ProviderConfig } from '../../shared/providers/types';
import type { ProviderFailure } from '../../shared/providers/failure';
import { ProviderError } from '../generation/errors';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
const encoder = new TextEncoder();

// Bound by UTF-8 bytes, including on multibyte supplier messages.
function bounded(value: string, bytes: number) {
  const encoded = encoder.encode(value);
  if (encoded.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

export function redactDiagnostic(
  value: string,
  secrets: readonly string[] = [],
  bytes = 4096,
): string {
  let safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const token of new Set([
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ]))
      safe = safe.split(token).join('[已隐藏]');
  }
  safe = safe
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[\w-]+/g, '[已隐藏]')
    .replace(
      /((?:api[-_ ]?key|authorization|access[-_ ]?token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,;"'<>]+/gi,
      '$1[已隐藏]',
    )
    .replace(/(?:data:[^\s;,]+;base64,)[a-z0-9+/=]+/gi, '[已省略附件]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => safeEndpoint(value) ?? '[已省略地址]');
  const dump = /\b(?:request|prompt|messages|input|contents|headers)\s*["']?\s*[:=]\s*[[{]/i.exec(
    safe,
  );
  if (dump) safe = `${safe.slice(0, dump.index)}[已省略请求内容]`;
  return bounded(safe.trim(), bytes);
}

function safeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    url.username = url.password = url.search = url.hash = '';
    return url.href.slice(0, 2048);
  } catch {
    return;
  }
}

function diagnosticBody(value: string, secrets: readonly string[]) {
  let safe: string;
  try {
    safe = JSON.stringify(
      JSON.parse(value),
      (key, entry: unknown) => {
        if (
          /^(?:(?:x[-_])?api[-_ ]?key|authorization|access[-_ ]?token|secret|password)$/i.test(key)
        )
          return '[已隐藏]';
        if (
          /^(?:request(?:[-_]?body)?|(?:system[-_]?)?prompt|messages|input|contents|headers)$/i.test(
            key,
          )
        )
          return '[已省略请求内容]';
        return typeof entry === 'string' ? redactDiagnostic(entry, secrets, 16 * 1024) : entry;
      },
      2,
    );
  } catch {
    // A truncated JSON body cannot be parsed; omit any remaining request echo.
    const dump =
      /\b(?:request(?:[-_]?body)?|(?:system[-_]?)?prompt|messages|input|contents|headers)\s*["']?\s*[:=]/i.exec(
        value,
      );
    safe = redactDiagnostic(
      dump ? `${value.slice(0, dump.index)}[已省略请求内容]` : value,
      secrets,
      16 * 1024,
    );
  }
  const text = bounded(safe.trim(), 4096);
  return { text, truncated: text !== safe.trim() };
}

export function providerFailure(
  config: ProviderConfig | undefined,
  stage: ProviderFailure['stage'],
  value?: unknown,
  options: {
    status?: number;
    headers?: Headers;
    secrets?: readonly string[];
    truncated?: boolean;
    responseBody?: string;
  } = {},
): ProviderFailure {
  const event = record(value),
    response = record(event.response),
    raw = event.error ?? response.error ?? value;
  const error = record(raw),
    secrets = [config?.apiKey ?? '', config?.systemPrompt ?? '', ...(options.secrets ?? [])];
  const clean = (value: unknown, limit: number) => {
    const text = scalar(value);
    return text ? redactDiagnostic(text, secrets, limit) || undefined : undefined;
  };
  const status =
    options.status ??
    (typeof error.code === 'number' && error.code >= 100 && error.code <= 599
      ? error.code
      : undefined);
  const candidate = config?.baseUrl
    ? redactDiagnostic(safeEndpoint(config.baseUrl) ?? '', secrets, 2048)
    : '';
  const body = options.responseBody ? diagnosticBody(options.responseBody, secrets) : undefined;
  const failure: ProviderFailure = {
    stage,
    occurredAt: Date.now(),
    ...(config
      ? {
          protocol: config.provider,
          providerId: clean(config.providerId, 64),
          providerName: clean(config.providerName, 100),
          model: clean(config.model, 200),
          modelName: clean(config.modelName, 200),
          endpoint: safeEndpoint(candidate),
        }
      : {}),
    status,
    code: clean(error.code ?? event.code, 128),
    type: clean(error.type ?? error.status, 128),
    message: clean(error.message ?? (typeof raw === 'string' ? raw : undefined), 4096),
    ...(body?.text ? { responseBody: body.text } : {}),
    requestId: clean(
      options.headers?.get('x-request-id') ??
        options.headers?.get('request-id') ??
        options.headers?.get('x-goog-request-id'),
      200,
    ),
    retryAfter: clean(options.headers?.get('retry-after'), 100),
    ...(options.truncated || body?.truncated ? { truncated: true } : {}),
  };
  while (
    encoder.encode(JSON.stringify(failure)).length > 8192 &&
    (failure.message || failure.responseBody)
  ) {
    const field =
      encoder.encode(failure.responseBody ?? '').length >
      encoder.encode(failure.message ?? '').length
        ? 'responseBody'
        : 'message';
    failure[field] = bounded(
      failure[field]!,
      Math.floor(encoder.encode(failure[field]!).length / 2),
    );
    failure.truncated = true;
  }
  return failure;
}

export function providerErrorSummary(failure: ProviderFailure): string {
  const http = failure.status ? `（HTTP ${failure.status}）` : '';
  const code = `${failure.code ?? ''} ${failure.type ?? ''} ${failure.message ?? ''}`;
  if (/insufficient_quota|quota_exceeded|insufficient.*balance|余额不足/i.test(code))
    return `模型供应商额度不足${http}，请检查余额或额度。`;
  if (failure.status === 429) return `模型供应商限制了请求${http}，请稍后重试并查看详情。`;
  if (failure.status === 401 || failure.status === 403)
    return `模型供应商拒绝访问${http}，请检查 API 密钥与权限。`;
  if (failure.status === 404) return `模型供应商找不到请求的模型或端点${http}。`;
  return failure.status
    ? `模型供应商返回 HTTP ${failure.status}，请查看错误详情。`
    : '模型供应商在生成期间返回错误，已保存部分内容。';
}

async function readErrorBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    truncated = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Error body timeout')), 2000);
  });
  try {
    while (size < 16 * 1024) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      const accepted = next.value.subarray(0, 16 * 1024 - size);
      chunks.push(accepted);
      size += accepted.length;
      if (size === 16 * 1024) truncated = true;
    }
  } catch {
    truncated = true;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export async function httpProviderError(
  response: Response,
  config: ProviderConfig,
  secrets: readonly string[] = [],
) {
  const body = await readErrorBody(response.body);
  let value: unknown = body.text;
  try {
    value = JSON.parse(body.text);
  } catch {
    if (/^\s*<(?:!doctype|html|head|body)/i.test(body.text)) value = '供应商返回 HTML 错误页面。';
  }
  const failure = providerFailure(config, 'response', value, {
    status: response.status,
    headers: response.headers,
    secrets,
    truncated: body.truncated,
    responseBody: body.text,
  });
  return new ProviderError(providerErrorSummary(failure), failure);
}
