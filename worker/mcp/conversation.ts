import type { Message } from '../../shared/conversation/types';
import type { GenerationResult } from '../../shared/streaming/generation';
import { addGenerationUsage } from '../../shared/streaming/generation';
import type { StreamState } from '../../shared/streaming/provider-stream';
import { mcpUsage } from '../../shared/usage/evidence';
import type { SqlQuery } from '../generation/metrics';
import type { GenerationProgress } from '../../shared/streaming/progress';
import { InputReceipts } from '../generation/input-receipts';

export function readMcpStatus(query: SqlQuery, assistantId: string) {
  const row = query<{
    status: Message['status'];
    payload: string | null;
    hasContent: number;
    progress: string | null;
    dependencyId: string | null;
    dependencyProgress: string | null;
    toolRound: number | null;
    checkpoint: string | null;
    continuedFrom: string | null;
  }>(
    `SELECT messages.status, message_generations.payload, generation_progress.payload AS progress,
      json_extract(message_continuations.payload, '$.sourceId') AS continuedFrom,
      generation_checkpoints.state AS checkpoint,
      run_dependencies.summaryId AS dependencyId, dependency_progress.payload AS dependencyProgress,
      json_extract(message_web_tools.payload, '$.round') AS toolRound,
      (messages.content != '' OR EXISTS (SELECT 1 FROM message_content_chunks WHERE messageId=messages.id AND channel='content' AND payload!='""')) AS hasContent
    FROM messages LEFT JOIN message_generations ON message_generations.messageId=messages.id
    LEFT JOIN message_continuations ON message_continuations.messageId=messages.id
    LEFT JOIN generation_progress ON generation_progress.messageId=messages.id
    LEFT JOIN run_dependencies ON run_dependencies.runId=messages.runId
    LEFT JOIN generation_progress AS dependency_progress ON dependency_progress.messageId=run_dependencies.summaryId
    LEFT JOIN message_web_tools ON message_web_tools.messageId=messages.id
    LEFT JOIN generation_checkpoints ON generation_checkpoints.runId=messages.runId
    WHERE messages.id=? AND messages.role='assistant'
      AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=messages.id)`,
    assistantId,
  ).toArray()[0];
  if (!row) return null;
  const generation = row.payload ? (JSON.parse(row.payload) as GenerationResult) : undefined;
  const pending = row.status === 'queued' || row.status === 'running';
  const checkpoint =
    row.checkpoint && pending ? (JSON.parse(row.checkpoint) as StreamState) : undefined;
  const usage = checkpoint
    ? addGenerationUsage(row.toolRound ? generation : undefined, {
        usage: checkpoint.usage,
        usageIsFinal: checkpoint.usageIsFinal,
        usageSources: checkpoint.usageSources,
      })
    : generation;
  const context = new InputReceipts(query).summary(assistantId, pending);
  const progress = row.progress ? (JSON.parse(row.progress) as GenerationProgress) : null;
  const dependencyProgress = row.dependencyProgress
    ? (JSON.parse(row.dependencyProgress) as GenerationProgress)
    : null;
  return {
    status: row.status,
    ...(row.continuedFrom ? { continuedFrom: row.continuedFrom } : {}),
    hasContent: Boolean(row.hasContent),
    context,
    providerResponse:
      checkpoint?.diagnostics?.response ?? generation?.diagnostics?.response ?? null,
    progress: progress
      ? {
          ...progress,
          lastProgressAt: Math.max(
            progress.lastProgressAt,
            dependencyProgress?.lastProgressAt ?? 0,
          ),
          toolRound: row.toolRound,
          dependency: row.dependencyId
            ? {
                type: 'summary' as const,
                messageId: row.dependencyId,
                phase: dependencyProgress?.phase ?? null,
                lastProgressAt: dependencyProgress?.lastProgressAt ?? null,
                revision: dependencyProgress?.revision ?? null,
              }
            : null,
        }
      : null,
    interrupted: Boolean(generation?.interrupted),
    finishReason: generation?.finishReason,
    rawFinishReason: generation?.rawFinishReason,
    usage: mcpUsage(
      usage?.usage ?? {},
      usage?.usageSources,
      usage?.usageCoverage,
      context.steps - (context.state === 'assembled' ? 1 : 0),
      usage?.usageIsFinal ?? false,
      !pending,
      new InputReceipts(query).latest(assistantId)?.protocol,
    ),
    // Provider response bodies, endpoints and arbitrary messages can contain credentials.
    ...(generation?.failure
      ? { failure: { stage: generation.failure.stage, httpStatus: generation.failure.status } }
      : {}),
  };
}
