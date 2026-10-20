import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ProviderConfig } from '../../shared/providers/types';
import {
  encodeGenerationEvent,
  ProviderStream,
  type GenerationEvent,
} from '../../shared/streaming/provider-stream';
import { ProviderError } from '../generation/errors';
import { providerFailure, providerErrorSummary, redactDiagnostic } from './failure';
import { ResponseReasoning } from './response-reasoning';
import { ProviderUsage } from './stream-usage';
import {
  ProviderToolCollector,
  type ProviderToolRequest,
  type ProviderToolTurn,
} from './tool-turn';
import type { ProviderWireGuard } from './stream-errors';

export interface ProviderResponse extends ReadableStream<Uint8Array> {
  toolTurn?: ProviderToolTurn;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function providerEvents(
  input: ReadableStream<LanguageModelV4StreamPart>,
  config: ProviderConfig,
  guard: ProviderWireGuard,
  signal: AbortSignal,
  secrets: readonly string[],
  headers: Headers | undefined,
  tools?: ProviderToolRequest,
): ProviderResponse {
  const reader = input.getReader(),
    usage = new ProviderUsage(),
    thoughts = new ResponseReasoning();
  const collector = tools ? new ProviderToolCollector(config, tools.enabled) : undefined;
  const budget = new ProviderStream(config.provider, true);
  let body: ProviderResponse;
  const diagnostics = (error: unknown, stage: 'stream' | 'protocol' = 'protocol') => {
    if (error instanceof ProviderError && error.details) return error;
    let detail = object(error);
    // SDK transport wrappers retain the guard's actionable cause.
    if (detail.cause instanceof Error) detail = object(detail.cause);
    const data = detail.data ?? detail;
    const failure = providerFailure(config, stage, data, {
      headers,
      secrets,
      status: typeof detail.statusCode === 'number' ? detail.statusCode : undefined,
      responseBody:
        typeof detail.responseBody === 'string'
          ? detail.responseBody
          : stage === 'stream' && !(error instanceof Error)
            ? JSON.stringify(data)
            : undefined,
    });
    return new ProviderError(
      stage === 'stream'
        ? providerErrorSummary(failure)
        : `供应商流格式无效或未完整结束：${failure.message ?? '连接中断'}。已保存部分内容。`,
      failure,
    );
  };
  async function* events(): AsyncGenerator<Uint8Array> {
    let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined;
    let nativeEnd = false,
      finishMessage: string | undefined;
    let pendingBudgetFailure: string | undefined;
    const emit = (event: GenerationEvent) => {
      const bytes = encodeGenerationEvent(event);
      budget.feed(bytes);
      budget.drainDeltas();
      const failure = budget.checkpoint().failure;
      // Deliver the bounded prefix before surfacing a capacity failure.
      if (failure) pendingBudgetFailure = failure;
      return bytes;
    };
    try {
      while (true) {
        if (pendingBudgetFailure) throw new Error(pendingBudgetFailure);
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        const part = next.value;
        if (part.type === 'error') throw diagnostics(part.error, 'stream');
        if (part.type === 'raw') {
          const raw = object(part.rawValue),
            response = object(raw.response);
          if (
            raw.type === 'response.completed' ||
            raw.type === 'response.incomplete' ||
            raw.type === 'message_stop'
          )
            nativeEnd = true;
          if (config.provider === 'gemini') {
            for (const candidate of Array.isArray(raw.candidates) ? raw.candidates : []) {
              const value = object(candidate);
              if (value.index !== undefined && value.index !== 0) continue;
              if (value.finishReason) nativeEnd = true;
              if (typeof value.finishMessage === 'string') finishMessage = value.finishMessage;
            }
            const blocked = object(raw.promptFeedback).blockReason;
            if (blocked) {
              nativeEnd = true;
              finishMessage = String(blocked);
            }
          }
          if (raw.error || raw.type === 'error' || raw.type === 'response.failed' || response.error)
            throw diagnostics(raw, 'stream');
          collector?.add(part);
          if (usage.observe(raw, config.provider))
            yield emit({ type: 'usage', usage: usage.usage });
          if (config.provider === 'openai-responses') {
            const thought = thoughts.observe(raw);
            if (thought) yield emit(thought);
          }
          continue;
        }
        if (part.type === 'finish') {
          if (finish) throw new Error('供应商重复返回结束事件。');
          finish = part;
          // The raw counter extension retains early counts and supplier totals;
          // fill only SDK-reported final fields the extension did not receive.
          const normalized = {
            inputTokens: part.usage.inputTokens.total,
            outputTokens: part.usage.outputTokens.total,
            cachedInputTokens: part.usage.inputTokens.cacheRead,
            cacheWriteInputTokens: part.usage.inputTokens.cacheWrite,
            reasoningTokens: part.usage.outputTokens.reasoning,
          };
          for (const [key, count] of Object.entries(normalized)) {
            if (count !== undefined && usage.usage[key as keyof typeof usage.usage] === undefined)
              usage.usage[key as keyof typeof usage.usage] = count;
          }
          continue;
        }
        if (finish) throw new Error('供应商在结束后继续发送内容。');
        collector?.add(part);
        if (part.type === 'text-delta') yield emit({ type: 'text', text: part.delta });
        else if (part.type === 'reasoning-delta' && config.provider !== 'openai-responses')
          yield emit({ type: 'reasoning', text: part.delta });
        else if (
          !collector &&
          ['tool-input-start', 'tool-call', 'tool-result', 'file', 'source'].includes(part.type)
        )
          throw new Error('模型返回了未启用的工具或不支持的内容。');
      }
      signal.throwIfAborted();
      if (
        !guard.ended ||
        (config.provider === 'openai-chat' ? !guard.chatDone : !nativeEnd) ||
        !finish
      )
        throw new Error('供应商连接提前结束，缺少完整结束标记。');
      const reason = finish.finishReason.unified;
      const rawReason =
        finish.finishReason.raw === undefined
          ? undefined
          : redactDiagnostic(
              finish.finishReason.raw,
              [config.apiKey ?? '', config.systemPrompt, ...secrets],
              128,
            );
      const message = finishMessage
        ? redactDiagnostic(finishMessage, [config.apiKey ?? '', config.systemPrompt, ...secrets])
        : undefined;
      const accepted =
        ['stop', 'length'].includes(reason) || (reason === 'tool-calls' && !!collector);
      if (accepted && collector) {
        collector.add(finish);
        body.toolTurn = collector.finish(usage.usage, usage.final);
      }
      yield emit({
        type: 'finish',
        reason,
        rawReason,
        message,
        usage: usage.usage,
        usageIsFinal: usage.final && accepted,
      });
      if (!accepted)
        throw diagnostics(
          {
            code: rawReason ?? reason,
            message: message ?? `供应商结束原因：${rawReason ?? reason}`,
          },
          'stream',
        );
    } catch (error) {
      throw diagnostics(error);
    } finally {
      await guard.cancel();
      // Stop upstream first, then drain bounded SDK prefetch. Cancelling an
      // Anthropic SDK tee directly leaves a rejected internal reader promise.
      try {
        while (!(await reader.read()).done) {
          /* Discard after terminal/failure. */
        }
      } catch {
        /* Preserve original failure. */
      }
      reader.releaseLock();
    }
  }
  const iterator = events();
  body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await guard.cancel();
      await iterator.return(undefined);
    },
  });
  return body;
}
