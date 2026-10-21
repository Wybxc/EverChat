import type { TextStreamPart, ToolSet } from 'ai';
import type { ProviderConfig } from '../../shared/providers/types';
import {
  encodeGenerationEvent,
  ProviderStream,
  type GenerationEvent,
} from '../../shared/streaming/provider-stream';
import { sdkDiagnostics, sdkProviderError } from './sdk-diagnostics';
import { redactDiagnostic } from './failure';
import { ResponseReasoning } from './response-reasoning';
import { ProviderUsage } from './stream-usage';
import type { ProviderToolTurn } from './tool-turn';
import type { ProviderNativeState } from './core';
import type { ProviderWireGuard } from './stream-errors';

export interface ProviderResponse extends ReadableStream<Uint8Array> {
  toolTurn?: ProviderToolTurn;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function providerEvents(
  input: ReadableStream<TextStreamPart<ToolSet>>,
  config: ProviderConfig,
  guard: ProviderWireGuard,
  signal: AbortSignal,
  secrets: readonly string[],
  headers: () => Headers | undefined,
  native: ProviderNativeState,
  onOutput?: (receivedAt: number) => void,
): ProviderResponse {
  const reader = input.getReader(),
    usage = new ProviderUsage(),
    thoughts = new ResponseReasoning();
  const collector = native.collector;
  const budget = new ProviderStream(config.provider, true);
  let body: ProviderResponse;
  const diagnostics = (error: unknown, stage: 'stream' | 'protocol' = 'protocol') =>
    sdkProviderError(error, config, stage, headers(), secrets);
  async function* events(): AsyncGenerator<Uint8Array> {
    let finished = false;
    let nativeEnd = false,
      finishMessage: string | undefined;
    let pendingBudgetFailure: string | undefined;
    const emit = (event: GenerationEvent) => {
      budget.accept(event);
      budget.drainDeltas();
      const failure = budget.failure;
      // Deliver the bounded prefix before surfacing a capacity failure.
      if (failure) pendingBudgetFailure = failure;
      if (onOutput && (event.type === 'text' || event.type === 'reasoning') && event.text) {
        const observed = onOutput;
        onOutput = undefined;
        observed(Date.now());
      }
      return encodeGenerationEvent(event);
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
          if (usage.observe(raw, config.provider))
            yield emit({ type: 'usage', usage: usage.usage });
          if (config.provider === 'openai-responses') {
            const thought = thoughts.observe(raw);
            if (thought) yield emit(thought);
          }
          continue;
        }
        if (part.type === 'finish-step') {
          if (finished) throw new Error('一次持久模型轮次不能发起多步生成。');
          finished = true;
          continue;
        }
        if (part.type === 'tool-call') collector?.acceptCall(part);
        if (part.type === 'start-step') {
          for (const detail of native.diagnostics.splice(0)) {
            const info = sdkDiagnostics(detail, config, secrets, headers());
            if (
              info.warnings.length ||
              Object.values(info.response ?? {}).some((value) => value !== undefined)
            )
              yield emit({ type: 'usage', usage: {}, diagnostics: info });
          }
        } else if (part.type === 'text-delta') yield emit({ type: 'text', text: part.text });
        else if (part.type === 'reasoning-delta' && config.provider !== 'openai-responses')
          yield emit({ type: 'reasoning', text: part.text });
        else if (
          !collector &&
          ['tool-input-start', 'tool-call', 'tool-result', 'file', 'source'].includes(part.type)
        )
          throw new Error('模型返回了未启用的工具或不支持的内容。');
      }
      signal.throwIfAborted();
      const finish = native.finish;
      if (
        !guard.ended ||
        (config.provider === 'openai-chat' ? !guard.chatDone : !nativeEnd) ||
        !finish ||
        !finished
      )
        throw new Error('供应商连接提前结束，缺少完整结束标记。');
      const reason = finish.finishReason.unified;
      usage.mergeSdk(finish.usage);
      for (const detail of native.diagnostics.splice(0)) {
        const info = sdkDiagnostics(detail, config, secrets, headers());
        if (info.warnings.length || info.response)
          yield emit({ type: 'usage', usage: {}, diagnostics: info });
      }
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
