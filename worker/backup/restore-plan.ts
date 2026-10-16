import type { BackupMessage,ConversationBackup } from '../../shared/backup/backup';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../shared/conversation/settings';
import type { ConversationSettings,Message } from '../../shared/conversation/types';
import { payloadBytes } from '../../shared/streaming/batches';

export function planConversationRestore(backup: ConversationBackup): { messages: Message[]; settings: ConversationSettings; batches: Message[][] } | { error: string; status: number } {
    const ids = new Map(backup.messages.map((message) => [message.id, crypto.randomUUID()]));
    const copiedGeneration = (source: BackupMessage) => {
      const generation = source.generation;
      if (!generation?.context?.summaryId) return generation;
      const { summaryId, ...context } = generation.context;
      return { ...generation, context: { ...context, ...(ids.has(summaryId) ? { summaryId: ids.get(summaryId)! } : {}) } };
    };
    const messages: Message[] = backup.messages.map((source) => ({
      id: ids.get(source.id)!, role: source.role, parts: source.deletedAt ? [] : source.parts, deletedAt: source.deletedAt,
      status: source.status, createdAt: source.createdAt, runId: null,
      parentId: source.parentId ? ids.get(source.parentId) ?? null : null,
      revisionOf: source.revisionOf ? ids.get(source.revisionOf) ?? null : null,
      error: source.error, providerId: source.providerId, model: source.model, modelName: source.modelName,
      ...(!source.deletedAt && source.role === 'assistant' && source.generation ? { generation: copiedGeneration(source) } : {}),
      ...(source.summary ? { summary: { ...source.summary, throughId: ids.get(source.summary.throughId)!, sourceIds: source.summary.sourceIds.map((id) => ids.get(id)!) } } : {}),
      ...(!source.deletedAt && source.tools ? { tools: source.tools } : {}),
    }));
    const batches: Message[][] = [], settings = backup.settings ?? DEFAULT_CONVERSATION_SETTINGS;
    const overhead = payloadBytes(JSON.stringify(settings)) + 64;
    let batch: Message[] = [], bytes = overhead;
    for (const message of messages) {
      const size = payloadBytes(JSON.stringify(message)) + 1;
      if (size + overhead > 1_000_000) return { error: '单条恢复消息过大。', status: 413 };
      if (batch.length && bytes + size > 1_000_000) { batches.push(batch); batch = []; bytes = overhead; }
      batch.push(message); bytes += size;
    }
    if (batch.length || !batches.length) batches.push(batch);
  return { messages, settings, batches };
}
