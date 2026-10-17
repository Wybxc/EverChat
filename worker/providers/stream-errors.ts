import type { ProviderConfig, ProviderKind } from '../../shared/providers/types';
import { ProviderError } from '../generation/errors';
import { providerErrorSummary, providerFailure } from './failure';

const MAX_ERROR_PREFIX_BYTES = 256 * 1024;

function dataLines(frame: string) {
  return frame
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line[5] === ' ' ? 6 : 5))
    .join('\n');
}

// Recognize only top-level normal-event fields. A quoted echo of "choices"
// inside an error message must never let an error envelope through.
function normalPrefix(protocol: ProviderKind, data: string) {
  let depth = 0,
    quoted = false,
    escaped = false,
    start = 0,
    key = '',
    expectingKey = false;
  let role: 'key' | 'value' | 'other' = 'other';
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (quoted) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char !== '"') continue;
      quoted = false;
      if (role === 'other') continue;
      let value: string;
      try {
        value = JSON.parse(data.slice(start, i + 1)) as string;
      } catch {
        return false;
      }
      if (role === 'key') {
        key = value;
        expectingKey = false;
        if (key === 'error') return false;
      } else if (key === 'type') {
        if (value === 'error' || value === 'response.failed') return false;
        if (
          protocol === 'anthropic' &&
          /^(?:message_start|content_block_start|content_block_delta|content_block_stop|message_delta|message_stop|ping)$/.test(
            value,
          )
        )
          return true;
        if (
          protocol === 'openai-responses' &&
          value.startsWith('response.') &&
          value !== 'response.failed'
        )
          return true;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      start = i;
      role = depth === 1 ? (expectingKey ? 'key' : 'value') : 'other';
    } else if (char === '{' || char === '[') {
      if (
        depth === 1 &&
        ((protocol === 'openai-chat' && ['choices', 'usage'].includes(key)) ||
          (protocol === 'gemini' &&
            ['candidates', 'usageMetadata', 'promptFeedback'].includes(key)))
      )
        return true;
      depth++;
      if (depth === 1) expectingKey = true;
    } else if (char === '}' || char === ']') depth--;
    else if (char === ',' && depth === 1) {
      expectingKey = true;
      key = '';
    }
  }
  return false;
}

// Normal events retain their exact bytes, including an unfinished UTF-8 code
// point. Only an unrecognized envelope is held until it can be checked safely.
export function safeProviderStream(
  body: ReadableStream<Uint8Array>,
  config: ProviderConfig,
  secrets: readonly string[],
) {
  const reader = body.getReader(),
    pending: Uint8Array[] = [];
  let held: Uint8Array[] = [],
    heldBytes = 0,
    prefix = '',
    inspectAt = 1,
    normal = false;
  let lineEmpty = true,
    afterCR = false,
    boundaryCR = false,
    ended = false,
    cancelled = false,
    failure: ProviderError | undefined;
  const fail = (value: unknown, stage: 'stream' | 'protocol' = 'stream') => {
    const details = providerFailure(config, stage, value, { secrets });
    failure ??= new ProviderError(
      stage === 'protocol' ? '供应商流格式无效，已保存部分内容。' : providerErrorSummary(details),
      details,
    );
  };
  const frameText = () => {
    const bytes = new Uint8Array(heldBytes);
    let offset = 0;
    for (const part of held) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  };
  const finishFrame = (incomplete = false) => {
    if (!normal && heldBytes) {
      try {
        const data = dataLines(frameText());
        if (data && data !== '[DONE]') {
          const value = JSON.parse(data) as Record<string, unknown>;
          if (
            value &&
            typeof value === 'object' &&
            (value.error ||
              value.type === 'error' ||
              value.type === 'response.failed' ||
              /^event:\s*(?:error|response\.failed)\s*$/m.test(frameText()))
          )
            fail(value);
          else if (incomplete) fail(undefined, 'protocol');
        }
        if (!failure) pending.push(...held);
      } catch {
        fail('供应商流事件格式无效。', 'protocol');
      }
    }
    held = [];
    heldBytes = 0;
    prefix = '';
    inspectAt = 1;
    normal = false;
  };
  const segment = (bytes: Uint8Array) => {
    if (!bytes.length || failure) return;
    if (normal) {
      pending.push(bytes);
      return;
    }
    held.push(bytes);
    heldBytes += bytes.length;
    const accepted = bytes.subarray(0, Math.max(0, 8192 - prefix.length));
    if (accepted.length) prefix += String.fromCharCode(...accepted);
    if (prefix.length >= inspectAt) {
      normal =
        !/^event:\s*(?:error|response\.failed)\s*$/m.test(prefix) &&
        normalPrefix(config.provider, dataLines(prefix.replace(/^\xef\xbb\xbf/, '')));
      inspectAt = Math.max(prefix.length + 1, prefix.length * 2);
      if (normal) {
        pending.push(...held);
        held = [];
        heldBytes = 0;
        prefix = '';
      }
    }
    if (!normal && heldBytes > MAX_ERROR_PREFIX_BYTES)
      fail('供应商错误响应超过安全解析大小。', 'protocol');
  };
  const feed = (bytes: Uint8Array) => {
    let start = 0;
    for (let i = 0; i < bytes.length && !failure; i++) {
      const byte = bytes[i];
      if (afterCR && byte === 10) {
        afterCR = false;
        if (boundaryCR) {
          pending.push(bytes.subarray(start, i + 1));
          start = i + 1;
        }
        boundaryCR = false;
        continue;
      }
      afterCR = false;
      boundaryCR = false;
      if (byte === 13 || byte === 10) {
        const boundary = lineEmpty;
        lineEmpty = true;
        afterCR = byte === 13;
        boundaryCR = boundary && afterCR;
        if (boundary) {
          segment(bytes.subarray(start, i + 1));
          finishFrame();
          start = i + 1;
        }
      } else lineEmpty = false;
    }
    if (!failure) segment(bytes.subarray(start));
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!pending.length && !ended && !failure) {
        try {
          const next = await reader.read();
          if (!next.done) feed(next.value);
          else {
            ended = true;
            finishFrame(true);
          }
        } catch {
          fail('供应商流读取中断。', 'protocol');
        }
      }
      if (failure) cancel();
      if (pending.length) controller.enqueue(pending.shift()!);
      else if (failure) controller.error(failure);
      else {
        reader.releaseLock();
        controller.close();
      }
    },
    cancel,
  });
}
