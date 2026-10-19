import { useMemo, useState } from 'react';
import type { Message } from '../../../shared/conversation/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import type { ChatModel, ModelSelection } from '../../../shared/models/types';
import { read, write } from '../../platform/storage';
import { cachedSnapshot, writeChatCache, type Pending } from './cache';

export function lastConversationModel(messages: Message[]): ModelSelection | undefined {
  let latest: Message | undefined;
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      !message.deletedAt &&
      !message.summary &&
      // Editing an older answer creates a revision without making a model request.
      (!message.revisionOf || message.runId || message.generation || message.streamVersion) &&
      message.providerId &&
      message.model &&
      (!latest || message.createdAt >= latest.createdAt)
    )
      latest = message;
  }
  return latest ? { providerId: latest.providerId!, model: latest.model! } : undefined;
}

const loadChoice = (id: string | null) => ({
  id,
  key: read<string | null>(id ? `chat-model:${id}` : 'chat-model', null),
});

export function useChatModel({
  id,
  models,
  defaultSelection,
  messages,
  ready,
  pending,
}: {
  id: string | null;
  models: ChatModel[];
  defaultSelection?: ModelSelection;
  messages: Message[];
  ready: boolean;
  pending?: Pending;
}) {
  const [choice, setChoice] = useState(() => loadChoice(id));
  // Restore during navigation so the previous conversation's model cannot be submitted.
  const current = choice.id === id ? choice : loadChoice(id);
  if (choice.id !== id) setChoice(current);
  const historical = useMemo(
    () => lastConversationModel(ready ? messages : id ? cachedSnapshot(id).messages : []),
    [id, messages, ready],
  );
  const previous =
    (pending && !pending.input.summaryThrough ? pending.input.selection : undefined) ?? historical;
  const key = current.key ?? (previous ? modelSelectionKey(previous) : null);
  const selectedModel =
    models.find((model) => modelSelectionKey(model) === key) ??
    models.find(
      (model) =>
        model.providerId === defaultSelection?.providerId && model.model === defaultSelection.model,
    ) ??
    models[0];

  const chooseModel = (key: string) => {
    setChoice({ id, key });
    if (id) writeChatCache(`chat-model:${id}`, key);
    write('chat-model', key);
  };
  return { selectedModel, chooseModel };
}
