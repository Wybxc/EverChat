import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import type { ProviderConfig } from '../../shared/providers/types';
import type { ModelProbeResult, ProbeCapability } from '../../shared/models/probe';
import { providerCallOptions, providerModel } from './sdk';
import { probeImage } from './probe-image';

export const PROBE_TIMEOUT_MS = 15_000,
  PROBE_RESPONSE_BYTES = 64 * 1024;
const toolName = 'everchat_capability_probe';
class ResponseTooLarge extends Error {}

export async function probeModelCapability(
  config: ProviderConfig,
  capability: ProbeCapability,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ModelProbeResult> {
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS),
    abort = AbortSignal.any([signal, timeout]);
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'user',
      content:
        capability === 'imageInput'
          ? [
              {
                type: 'text',
                text: 'Read the six-character hexadecimal code in the image. Reply with only that code, without spaces or explanations.',
              },
              {
                type: 'file',
                data: { type: 'data', data: probeImage(nonce) },
                mediaType: 'image/png',
              },
            ]
          : [
              {
                type: 'text',
                text:
                  capability === 'text'
                    ? `Reply with exactly ${nonce} and nothing else.`
                    : `Call ${toolName} with challenge exactly "${nonce}". Do not answer in text.`,
              },
            ],
    },
  ];
  const tools: LanguageModelV4CallOptions['tools'] =
    capability === 'toolCalls'
      ? [
          {
            type: 'function',
            name: toolName,
            description:
              'Return the supplied verification challenge. This function is only inspected and never executed.',
            inputSchema: {
              type: 'object',
              properties: { challenge: { type: 'string', enum: [nonce] } },
              required: ['challenge'],
              additionalProperties: false,
            },
          },
        ]
      : undefined;
  let oversized = false;
  const boundedFetch: typeof globalThis.fetch = async (input, init) => {
    abort.throwIfAborted();
    const response = await fetch(input, { ...init, signal: abort, redirect: 'manual' });
    // Never expose supplier error bodies (which can echo credentials) or follow redirects.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Probe request failed');
    }
    if (!response.body) throw new Error('Empty response');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    abort.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        abort.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > PROBE_RESPONSE_BYTES) {
          oversized = true;
          throw new ResponseTooLarge();
        }
        chunks.push(result.value);
      }
      abort.throwIfAborted();
    } finally {
      abort.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  const result = (reason: ModelProbeResult['reason']): ModelProbeResult => ({
    capability,
    status: reason === 'matched' ? 'confirmed' : 'unconfirmed',
    reason,
    testedAt: Date.now(),
  });
  try {
    // Probes have their own small budget; never inherit the conversation, prompt, tools or output limit.
    const probeConfig: ProviderConfig = {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      systemPrompt: '',
      maxOutputTokens: 256,
      reasoningEnabled: false,
    };
    const options = providerCallOptions(probeConfig, prompt, abort, tools);
    // A tool-capable model must make the actual call. No returned tool is executed.
    if (tools) options.toolChoice = { type: 'required' };
    const response = await providerModel(probeConfig, boundedFetch).doGenerate(options);
    const content: LanguageModelV4Content[] = response.content;
    if (capability !== 'toolCalls') {
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim()
        .toUpperCase();
      return result(text === nonce ? 'matched' : 'mismatch');
    }
    const calls = content.filter((part) => part.type === 'tool-call');
    if (calls.length !== 1 || calls[0].toolName !== toolName) return result('mismatch');
    try {
      const input: unknown = JSON.parse(calls[0].input);
      return result(
        input &&
          typeof input === 'object' &&
          Object.keys(input).length === 1 &&
          (input as { challenge?: unknown }).challenge === nonce
          ? 'matched'
          : 'mismatch',
      );
    } catch {
      return result('mismatch');
    }
  } catch {
    if (signal.aborted) throw signal.reason;
    return result(
      timeout.aborted ? 'timeout' : oversized ? 'response-too-large' : 'request-failed',
    );
  }
}
