import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  experimental_streamTextLowMemory as streamText,
  wrapLanguageModel,
  tool,
  jsonSchema,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import * as v from 'valibot';
import type { ProviderConfig } from '../../shared/providers/types';
import { webToolInputSchemasFor } from '../../shared/web-tools/tasks';
import { providerCallOptions } from './sdk';
import {
  ProviderToolCollector,
  webToolDefinitions,
  toolContinuationChoice,
  type ProviderToolRequest,
} from './tool-turn';

/** Only private continuation and native completion evidence live beside Core's stream. */
export interface ProviderNativeState {
  finish?: Extract<LanguageModelV4StreamPart, { type: 'finish' }>;
  failure?: unknown;
  collector?: ProviderToolCollector;
  diagnostics: Extract<LanguageModelV4StreamPart, { type: 'stream-start' | 'response-metadata' }>[];
}

export async function coreProviderStream(
  model: LanguageModelV4,
  config: ProviderConfig,
  messages: ModelMessage[],
  signal: AbortSignal,
  request?: ProviderToolRequest,
) {
  let connected = false;
  const native: ProviderNativeState = {
    diagnostics: [],
    collector: request ? new ProviderToolCollector(config, request.enabled) : undefined,
  };
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      async wrapStream({ doStream }) {
        const result = await doStream();
        connected = true;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (native.failure) return;
                try {
                  if (part.type === 'finish') {
                    if (native.finish) throw new Error('供应商重复返回结束事件。');
                    native.finish = part;
                  } else if (native.finish && part.type !== 'raw') {
                    throw new Error('供应商在结束后继续发送内容。');
                  }
                  if (part.type === 'stream-start' || part.type === 'response-metadata') {
                    if (native.diagnostics.length >= 8)
                      throw new Error('供应商返回了过多响应资料。');
                    native.diagnostics.push(part);
                  }
                  native.collector?.add(part);
                  controller.enqueue(part);
                } catch (error) {
                  native.failure = error;
                  // Core handles error parts locally. Throwing inside a middleware
                  // transform also rejects its internal content/tee promises.
                  controller.enqueue({ type: 'error', error });
                }
              },
            }),
          ),
        };
      },
    },
  });
  const inputSchemas = webToolInputSchemasFor(config.webTools?.provider);
  const definitions = request ? webToolDefinitions(request.enabled, config) : undefined;
  const options = providerCallOptions(config, [], signal, definitions);
  const tools = definitions
    ? Object.fromEntries(
        definitions.map((definition) => [
          definition.name,
          tool({
            description: definition.description,
            inputSchema: jsonSchema(definition.inputSchema, {
              validate(value) {
                const parsed = v.safeParse(
                  inputSchemas[definition.name as keyof typeof inputSchemas],
                  value,
                );
                return parsed.success
                  ? { success: true, value: parsed.output }
                  : { success: false, error: new v.ValiError(parsed.issues) };
              },
            }),
            strict: definition.strict,
            // DO claims and executes tools after native completion; Core must not execute or loop.
          }),
        ]),
      )
    : undefined;
  const result = streamText({
    model: wrapped,
    messages,
    allowSystemInMessages: true,
    tools,
    ...(request
      ? { toolChoice: request.toolChoice ?? toolContinuationChoice(request.exchanges ?? []) }
      : {}),
    maxRetries: 0,
    includeRawChunks: true,
    abortSignal: signal,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    topP: options.topP,
    reasoning: options.reasoning,
    providerOptions: options.providerOptions,
    telemetry: { isEnabled: false },
    // A provider stream error is observed by providerEvents, never retried or logged raw.
    onError() {},
  });
  // Preserve the call boundary: HTTP rejection is reported before returning a
  // response stream. Core is lazy, so consume only its bounded startup prefix.
  const reader = result.fullStream.getReader();
  const prefix: TextStreamPart<ToolSet>[] = [];
  try {
    while (!connected) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) throw new Error('模型供应商连接未建立。');
      if (next.value.type === 'error') throw next.value.error;
      prefix.push(next.value);
      if (prefix.length > 4) throw new Error('供应商连接状态无效。');
    }
  } catch (error) {
    // Terminal startup parts contain no supplier content and need no replay.
    await reader.cancel().catch(() => {});
    throw error;
  }
  return {
    native,
    stream: new ReadableStream({
      start(controller) {
        prefix.forEach((part) => controller.enqueue(part));
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    }),
  };
}
