import type { ProviderKind } from '../../shared/providers/types';
import type { StreamUsage } from '../../shared/streaming/provider-stream';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
// Preserve reported counters, including partial usage before a disconnect. SDK
// final usage alone cannot recover Anthropic's initial input or Gemini's raw total.
export class ProviderUsage {
  usage: StreamUsage = {};
  reported = false;
  final = false;
  private nativeFinished = false;
  private promptInputTokens?: number;
  observe(event: Record<string, unknown>, kind: ProviderKind) {
    const value =
      kind === 'anthropic' && event.type === 'message_start'
        ? object(event.message).usage
        : kind === 'openai-responses'
          ? object(event.response).usage
          : kind === 'gemini'
            ? event.usageMetadata
            : event.usage;
    const updated = this.record(value, kind);
    this.reported ||= updated;
    const choices = Array.isArray(event.choices) ? event.choices.map(object) : [];
    if (
      kind === 'openai-chat' &&
      updated &&
      (choices.length === 0 || choices.some((choice) => choice.finish_reason != null))
    )
      this.final = true;
    if (
      kind === 'openai-responses' &&
      ['response.completed', 'response.incomplete'].includes(String(event.type))
    )
      this.final = updated;
    if (
      kind === 'anthropic' &&
      event.type === 'message_delta' &&
      object(event.delta).stop_reason != null &&
      number(object(event.usage).output_tokens) !== undefined
    )
      this.final = true;
    if (kind === 'gemini') {
      this.nativeFinished ||= (Array.isArray(event.candidates) ? event.candidates : []).some(
        (value) => !!object(value).finishReason,
      );
      if (updated && this.nativeFinished) this.final = true;
    }
    return updated;
  }
  record(value: unknown, kind: ProviderKind) {
    const usage = object(value),
      inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details),
      outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details);
    const next: StreamUsage =
      kind === 'gemini'
        ? {
            textOutputTokens: number(usage.candidatesTokenCount),
            totalTokens: number(usage.totalTokenCount),
            cachedInputTokens: number(usage.cachedContentTokenCount),
            reasoningTokens: number(usage.thoughtsTokenCount),
            toolInputTokens: number(usage.toolUsePromptTokenCount),
          }
        : kind === 'anthropic'
          ? {
              uncachedInputTokens: number(usage.input_tokens),
              outputTokens: number(usage.output_tokens),
              cachedInputTokens: number(usage.cache_read_input_tokens),
              cacheWriteInputTokens: number(usage.cache_creation_input_tokens),
              reasoningTokens: number(outputDetails.thinking_tokens),
            }
          : {
              inputTokens: number(usage.input_tokens) ?? number(usage.prompt_tokens),
              outputTokens: number(usage.output_tokens) ?? number(usage.completion_tokens),
              totalTokens: number(usage.total_tokens),
              cachedInputTokens:
                number(inputDetails.cached_tokens) ?? number(usage.prompt_cache_hit_tokens),
              cacheWriteInputTokens: number(inputDetails.cache_write_tokens),
              reasoningTokens: number(outputDetails.reasoning_tokens),
            };
    for (const [key, value] of Object.entries(next))
      if (value !== undefined) this.usage[key as keyof StreamUsage] = value;
    const report = this.usage;
    if (kind === 'anthropic' && report.uncachedInputTokens !== undefined) {
      report.inputTokens = number(
        report.uncachedInputTokens +
          (report.cachedInputTokens ?? 0) +
          (report.cacheWriteInputTokens ?? 0),
      );
    }
    if (kind === 'gemini') {
      // These API counters are disjoint. Keep the reported total; never invent one.
      this.promptInputTokens = number(usage.promptTokenCount) ?? this.promptInputTokens;
      if (this.promptInputTokens !== undefined)
        report.inputTokens = number(this.promptInputTokens + (report.toolInputTokens ?? 0));
      if (report.textOutputTokens !== undefined)
        report.outputTokens = number(report.textOutputTokens + (report.reasoningTokens ?? 0));
    }
    return Object.values(next).some((value) => value !== undefined);
  }
}
