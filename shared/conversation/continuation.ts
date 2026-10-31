import { messageParts, messageText } from './content';
import { isActive } from './message-state';
import type { AnswerStage, Message } from './types';
import * as v from 'valibot';
import { generationSchema } from '../streaming/generation';
import { publicToolTaskSchema } from '../tools/tasks';

const length = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const name = v.optional(v.nullable(v.string()));
export const continuationSchema = v.pipe(
  v.strictObject({
    sourceId: v.string(),
    sourceTextSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    prefixTextLength: length,
    prefixReasoningLength: length,
    detached: v.optional(v.literal(true)),
    stages: v.array(
      v.strictObject({
        id: v.string(),
        status: v.picklist(['completed', 'failed', 'cancelled']),
        createdAt: length,
        contentLength: length,
        reasoningLength: length,
        providerId: name,
        model: name,
        modelName: name,
        generation: v.optional(generationSchema),
        tools: v.optional(publicToolTaskSchema),
      }),
    ),
  }),
  v.check(
    (value) =>
      value.stages.length > 0 &&
      new Set(value.stages.map((stage) => stage.id)).size === value.stages.length &&
      value.stages.at(-1)?.id === value.sourceId &&
      value.stages.reduce((sum, stage) => sum + stage.contentLength, 0) ===
        value.prefixTextLength &&
      value.stages.reduce((sum, stage) => sum + stage.reasoningLength, 0) ===
        value.prefixReasoningLength,
  ),
);

export const CONTINUE_REQUEST = '继续';

export function canContinueAnswer(message: Message) {
  return (
    message.role === 'assistant' &&
    !message.deletedAt &&
    !message.summary &&
    !isActive(message) &&
    Boolean(messageText(message).trim()) &&
    (!message.continuation || Boolean(localAnswerText(message).trim()))
  );
}

export function localAnswerText(message: Message, channel: 'text' | 'reasoning' = 'text') {
  return messageText(message, channel).slice(
    channel === 'text'
      ? (message.continuation?.prefixTextLength ?? 0)
      : (message.continuation?.prefixReasoningLength ?? 0),
  );
}

/** Keep supplier stream offsets and parser state local to the new execution. */
export function withAnswerDelta(message: Message, content: string, reasoning: string): Message {
  return {
    ...message,
    parts: messageParts(
      messageText(message).slice(0, message.continuation?.prefixTextLength ?? 0) + content,
      messageText(message, 'reasoning').slice(0, message.continuation?.prefixReasoningLength ?? 0) +
        reasoning,
    ),
  };
}

export function answerStage(message: Message): AnswerStage {
  return {
    id: message.id,
    status: message.status,
    createdAt: message.createdAt,
    contentLength: localAnswerText(message).length,
    reasoningLength: localAnswerText(message, 'reasoning').length,
    providerId: message.providerId,
    model: message.model,
    modelName: message.modelName,
    generation: message.generation,
    tools: message.tools,
  };
}

/** Project each execution into its own reasoning/tool coordinate space. */
export function answerStages(message: Message): Message[] {
  if (!message.continuation) return [message];
  let textOffset = 0,
    reasoningOffset = 0;
  return [...message.continuation.stages, answerStage(message)].map((stage) => {
    const result: Message = {
      ...message,
      ...stage,
      status: stage.status,
      parts: messageParts(
        messageText(message).slice(textOffset, textOffset + stage.contentLength),
        messageText(message, 'reasoning').slice(
          reasoningOffset,
          reasoningOffset + stage.reasoningLength,
        ),
      ),
      continuation: undefined,
    };
    textOffset += stage.contentLength;
    reasoningOffset += stage.reasoningLength;
    return result;
  });
}
