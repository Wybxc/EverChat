import type { Message } from '../conversation/types';
import type { Snapshot, DurableChange, StreamBatch } from './protocol';
import { ProviderStream } from './provider-stream';
import { validateBatch, validateCommit } from './batches';
import { localAnswerText, withAnswerDelta } from '../conversation/continuation';
export function applyChange(snapshot: Snapshot, change: DurableChange): Snapshot {
  if (change.seq <= snapshot.seq) return snapshot;
  if (change.seq !== snapshot.seq + 1) throw new Error('Sync sequence gap');
  const messages = [...snapshot.messages];
  if (change.type === 'commit') {
    const index = messages.findIndex((message) => message.id === change.messageId);
    if (index === -1) throw new Error('Missing streamed message');
    validateCommit(change);
    for (const batch of change.batches) messages[index] = appendMessage(messages[index], batch);
    return { ...snapshot, messages, seq: change.seq };
  }
  for (const message of change.messages) {
    const index = messages.findIndex((existing) => existing.id === message.id);
    if (index === -1) messages.push(message);
    else messages[index] = message;
  }
  return {
    ...snapshot,
    messages,
    seq: change.seq,
    ...(change.settings ? { settings: change.settings } : {}),
    ...(change.activity ? { activity: change.activity } : {}),
  };
}

export function appendMessage(message: Message, batch: StreamBatch): Message {
  const bytes = validateBatch(batch);
  if (
    message.streamVersion !== batch.version ||
    message.role !== 'assistant' ||
    message.id !== batch.messageId ||
    message.runId !== batch.runId ||
    !message.streamState
  )
    throw new Error('Stream identity mismatch');
  if (message.status !== 'running') throw new Error('Streamed message is not running');
  if (batch.startOffset !== (message.durableOffset ?? 0)) throw new Error('Stream offset gap');
  const state = message.streamState;
  const parser = new ProviderStream(
    state.protocol,
    state.showReasoning,
    state,
    localAnswerText(message),
    localAnswerText(message, 'reasoning'),
  );
  parser.feed(bytes);
  return {
    ...withAnswerDelta(message, parser.content, parser.reasoning),
    streamState: parser.checkpoint(),
    durableOffset: batch.endOffset,
  };
}
