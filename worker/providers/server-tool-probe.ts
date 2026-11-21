import type { ProviderConfig } from '../../shared/providers/types';
import {
  serverToolProbeCandidates,
  type ServerToolProbeKind,
} from '../../shared/tools/server-tools';
import { ProviderStream } from '../../shared/streaming/provider-stream';
import { ProviderError } from '../generation/errors';
import { openProviderStream } from './stream';
import { PROBE_RESPONSE_BYTES, PROBE_TIMEOUT_MS } from './probe';

export async function probeServerTool(
  config: ProviderConfig,
  tool: ServerToolProbeKind,
  start: () => Promise<void>,
) {
  const candidate = serverToolProbeCandidates(config).find((entry) => entry.tool === tool);
  if (!candidate) throw new ProviderError('当前接口没有已知的工具测试方式。');
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
  const parser = new ProviderStream(config.provider, false);
  let complete = false;
  try {
    const stream = await openProviderStream(
      {
        ...config,
        systemPrompt: '',
        maxOutputTokens: 256,
        reasoningEnabled: false,
        serverToolCallLimit: 1,
        serverTools: [candidate],
        remoteMcp: undefined,
      },
      [
        {
          role: 'user',
          content:
            tool === 'web-fetch'
              ? 'Read https://www.rfc-editor.org/rfc/rfc9110 with the URL tool. Give only its title.'
              : 'Make one web search for RFC 9110 on rfc-editor.org and give only the official document title.',
        },
      ],
      signal,
      undefined,
      undefined,
      undefined,
      start,
    );
    let bytes = 0;
    for await (const part of stream) {
      if ((bytes += part.byteLength) > PROBE_RESPONSE_BYTES) break;
      parser.feed(part);
    }
    parser.assertComplete();
    complete = true;
  } catch {
    // Only validated execution evidence confirms availability.
  } finally {
    abort.abort();
  }
  const state = parser.checkpoint();
  const confirmed =
    complete &&
    Boolean(
      state.serverTools?.some((entry) => entry.tool === tool && entry.status === 'completed'),
    );
  return {
    confirmed,
    complete,
    usage: state.usage,
    usageIsFinal: state.usageIsFinal && complete,
    usageSources: state.usageSources,
    serverToolUsage: state.serverToolUsage,
  };
}
