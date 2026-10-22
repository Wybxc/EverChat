import { generateText, tool, ToolChoiceViolationError, type ModelMessage } from 'ai';
import { valibotSchema } from '@ai-sdk/valibot';
import * as v from 'valibot';
import type { ProviderConfig } from '../../shared/providers/types';
import type { ModelProbeResult, ProbeCapability } from '../../shared/models/probe';
import { providerGenerationOptions, providerModel, providerRequestInit } from './sdk';
import { probeImage } from './probe-image';
import { sdkProviderError } from './sdk-diagnostics';
import { httpProviderError } from './failure';
import { ProviderError } from '../generation/errors';
import { coreUsage } from '../../shared/usage/normalize';
import type { StreamUsage } from '../../shared/streaming/provider-stream';
import { boundedJsonResponse, ProviderResponseTooLarge } from './response-body';

export const PROBE_TIMEOUT_MS = 15_000,
  PROBE_RESPONSE_BYTES = 64 * 1024;
const toolName = 'everchat_capability_probe';

export async function probeModelCapability(
  config: ProviderConfig,
  capability: ProbeCapability,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  accounting?: {
    start: () => Promise<void>;
    finish: (
      status: 'completed' | 'failed' | 'cancelled',
      usage: StreamUsage,
      final: boolean,
      httpStatus?: number,
    ) => void;
  },
): Promise<ModelProbeResult> {
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS),
    abort = AbortSignal.any([signal, timeout]);
  const prompt: ModelMessage[] = [
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
                data: probeImage(nonce),
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
  const tools =
    capability === 'toolCalls'
      ? {
          [toolName]: tool({
            description:
              'Return the supplied verification challenge. This function is only inspected and never executed.',
            inputSchema: valibotSchema(v.strictObject({ challenge: v.literal(nonce) })),
          }),
        }
      : undefined;
  let oversized = false;
  let usage: StreamUsage = {},
    final = false,
    httpStatus: number | undefined;
  const boundedFetch: typeof globalThis.fetch = async (input, init) => {
    abort.throwIfAborted();
    await accounting?.start();
    const response = await fetch(input, {
      ...providerRequestInit(config, init),
      signal: abort,
      redirect: 'manual',
    });
    httpStatus = response.status;
    if (!response.ok) {
      throw await httpProviderError(response, config);
    }
    try {
      return await boundedJsonResponse(response, PROBE_RESPONSE_BYTES, abort);
    } catch (error) {
      oversized = error instanceof ProviderResponseTooLarge;
      throw error;
    }
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
    // A tool-capable model must make the actual call. No returned tool is executed.
    const response = await generateText({
      model: providerModel(probeConfig, boundedFetch),
      messages: prompt,
      tools,
      ...(tools ? { toolChoice: 'required' } : {}),
      maxRetries: 0,
      abortSignal: abort,
      ...providerGenerationOptions(probeConfig),
      telemetry: { isEnabled: false },
      onLanguageModelCallEnd(event) {
        // A valid response is billable even if Core subsequently rejects its
        // required-tool choice. A capability mismatch is not a failed request.
        usage = coreUsage(event.usage);
        final = true;
      },
    });
    usage = coreUsage(response.usage);
    final = true;
    if (capability !== 'toolCalls') {
      const text = response.text.trim().toUpperCase();
      return result(text === nonce ? 'matched' : 'mismatch');
    }
    const calls = response.toolCalls;
    if (calls.length !== 1 || calls[0].toolName !== toolName) return result('mismatch');
    try {
      if (calls[0].invalid) return result('mismatch');
      const input: unknown = calls[0].input;
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
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (ToolChoiceViolationError.isInstance(error)) return result('mismatch');
    return {
      ...result(timeout.aborted ? 'timeout' : oversized ? 'response-too-large' : 'request-failed'),
      failure:
        error instanceof ProviderError && error.details
          ? error.details
          : sdkProviderError(error, config, 'connect').details,
    };
  } finally {
    accounting?.finish(
      signal.aborted ? 'cancelled' : final ? 'completed' : 'failed',
      usage,
      final,
      httpStatus,
    );
  }
}
