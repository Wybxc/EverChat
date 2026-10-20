import type { Message } from '../../../shared/conversation/types';

/** A failed tool can also terminate generation; its detailed alert already describes that fault. */
export function isReportedToolFailure(message: Message) {
  if (!message.tools?.calls.some(({ result }) => result?.status === 'failed')) return false;
  const failure = message.generation?.failure;
  if (failure) return failure.stage === 'tool';
  return (
    message.generation?.issue?.code === 'TOOL_FAILED' ||
    message.tools.calls.some(
      ({ result }) => result?.status === 'failed' && result.error === message.error,
    )
  );
}
