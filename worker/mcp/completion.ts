import type { GenerationResult } from '../../shared/streaming/generation';
import type { CompletionResult, RunResult } from './contracts';

// Paging is deliberately independent of generation completeness. An exhausted
// page can be followed by more persisted text, or by a new model call chosen by
// the caller after a provider length limit.
export function readCompletion(
  status: RunResult['status'],
  generation?: Pick<GenerationResult, 'finishReason' | 'rawFinishReason'>,
): CompletionResult | null {
  if (status === 'accepted' || status === 'running') return null;
  const reason = generation?.finishReason ?? null;
  const length = reason === 'length';
  const complete = status === 'completed' && reason === 'stop';
  return {
    state: complete
      ? 'complete'
      : length || reason === 'content-filter' || status !== 'completed'
        ? 'incomplete'
        : 'unknown',
    truncated: length ? true : complete ? false : null,
    reason: length ? 'provider_length_limit' : reason,
    // Only the bounded native finish code, never an arbitrary provider message.
    rawFinishReason:
      generation?.rawFinishReason && /^[\w.-]{1,128}$/.test(generation.rawFinishReason)
        ? generation.rawFinishReason
        : null,
    requiresNewGeneration: !complete,
  };
}
