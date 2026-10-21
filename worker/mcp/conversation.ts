import type { Message } from '../../shared/conversation/types';
import type { GenerationResult } from '../../shared/streaming/generation';
import type { SqlQuery } from '../generation/metrics';

export function readMcpStatus(query: SqlQuery, assistantId: string) {
  const row = query<{
    status: Message['status'];
    payload: string | null;
    hasContent: number;
  }>(
    `SELECT messages.status, message_generations.payload,
      (messages.content != '' OR EXISTS (SELECT 1 FROM message_content_chunks WHERE messageId=messages.id AND channel='content' AND payload!='""')) AS hasContent
    FROM messages LEFT JOIN message_generations ON message_generations.messageId=messages.id
    WHERE messages.id=? AND messages.role='assistant'
      AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=messages.id)`,
    assistantId,
  ).toArray()[0];
  if (!row) return null;
  const generation = row.payload ? (JSON.parse(row.payload) as GenerationResult) : undefined;
  return {
    status: row.status,
    hasContent: Boolean(row.hasContent),
    interrupted: Boolean(generation?.interrupted),
    finishReason: generation?.finishReason,
    usage: { ...generation?.usage, isFinal: generation?.usageIsFinal ?? false },
    // Provider response bodies, endpoints and arbitrary messages can contain credentials.
    ...(generation?.failure
      ? { failure: { stage: generation.failure.stage, httpStatus: generation.failure.status } }
      : {}),
  };
}
