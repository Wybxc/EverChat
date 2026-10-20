import { DurableObject } from 'cloudflare:workers';
import { DocumentError, type DocumentPart } from '../../shared/attachments/documents';
import {
  backupMessage,
  type BackupMessage,
  type ConversationBackup,
} from '../../shared/backup/backup';
import { branchPath } from '../../shared/conversation/branch-path';
import {
  messageFiles,
  messageImages,
  messageParts,
  messageText,
} from '../../shared/conversation/content';
import {
  assertContextFits,
  assertStoredContextFits,
  buildContext,
  ContextBudgetError,
  historyCountWithinLimit,
} from '../../shared/conversation/context-budget';
import { MESSAGE_TEXT_LIMIT_MESSAGE, messageTextFits } from '../../shared/conversation/limits';
import { isActive } from '../../shared/conversation/message-state';
import { applyConversationSettings } from '../../shared/conversation/settings';
import {
  MAX_SUMMARIES,
  MAX_SUMMARY_CHARACTERS,
  prepareChatContext,
  summaryContext,
  summaryGeneration,
  summaryPrefix,
} from '../../shared/conversation/summaries';
import type {
  ConversationSettings,
  Message,
  MessageStatus,
  Submission,
  SubmitInput,
} from '../../shared/conversation/types';
import type { ErrorIssue } from '../../shared/errors/descriptor';
import { AppError, issueOf, problem } from '../../shared/errors/descriptor';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import type { SearchPage } from '../../shared/search/query';
import { projectShare } from '../../shared/sharing/projection';
import { commitAck, STREAM_VERSION, validateCommit } from '../../shared/streaming/batches';
import type { GenerationMeasurements } from '../../shared/streaming/metrics';
import type {
  Change,
  Commit,
  DurableChange,
  GenerationExecutor,
  Snapshot,
  StreamBatch,
  StreamCommit,
} from '../../shared/streaming/protocol';
import { ProviderStream, StreamParseError } from '../../shared/streaming/provider-stream';
import { planConversationRestore } from '../backup/restore-plan';
import { loadGenerationDocument, loadGenerationImage } from '../generation/attachments';
import { GenerationBuffer } from '../generation/buffer';
import { consumeModelStream, type ActiveGeneration } from '../generation/consume-stream';
import { GenerationCancelled, ProviderError, providerIssue } from '../generation/errors';
import { GenerationMeter, measuredQuery } from '../generation/metrics';
import { mergeGenerationDiagnostics } from '../../shared/streaming/diagnostics';
import { generationTiming } from '../generation/timing';
import type { Env } from '../http/env';
import { json } from '../http/response';
import { CompletionOutbox } from '../notifications/outbox';
import {
  DATABASE_LIMIT_MESSAGE,
  MAX_DATABASE_BYTES,
  MAX_DATABASE_START_BYTES,
  MAX_DATABASE_WRITE_BYTES,
  MAX_MESSAGES,
  storageErrorMessage,
} from '../platform/resource-limits';
import { initializeStorageSchema } from '../platform/storage-schema';
import { openProviderStream } from '../providers/stream';
import { searchRetryDelay } from '../search/index';
import { GenerationCheckpoints } from '../streaming/checkpoints';
import {
  ConversationSubscribers,
  validSubscription,
  type Attachment,
} from '../streaming/subscribers';
import { modelIdentity, UsageAccounting } from '../usage/accounting';
import { USAGE_OUTBOX_SCHEMA } from '../usage/schema';
import { ConversationActivityJournal } from './activity';
import { databaseUsage } from './capacity';
import { ConversationMessages, type Row } from './messages';
import { DELETION_SCHEMA, initializeConversation } from './schema';
import { ConversationState, requestFingerprint } from './state';
import { planSubmissionParent } from './submission-plan';
import { ConversationTitles, TITLE_JOBS_SCHEMA } from './titles';

import { createHash } from 'node:crypto';
import { ImageContextError, type ImagePart } from '../../shared/attachments/images';
import type { ProviderFailure } from '../../shared/providers/failure';
import { addGenerationUsage } from '../../shared/streaming/generation';
import { updateToolTask } from '../../shared/web-tools/reasoning-flow';
import type { WebToolServiceConfig } from '../../shared/web-tools/service';
import {
  assertWebToolSupport,
  type PublicToolTask,
  type ReasoningBreak,
  type WebToolCall,
  type WebToolName,
  type WebToolOutcome,
} from '../../shared/web-tools/tasks';
import { providerFailure } from '../providers/failure';
import { type ProviderToolTurn } from '../providers/tool-turn';
import { executeWebTool, terminalWebToolError, type WebToolFetch } from '../web-tools/service';
import { WEB_TOOL_QUOTA_ERROR } from '../web-tools/settings';
import { ToolTaskJournal, type ToolTaskState } from '../web-tools/task-journal';
import { toolWorkflowId, type ToolWorkflowParams } from '../web-tools/workflow';
type Run = {
  id: string;
  conversationId: string;
  assistantId: string;
  context: string;
  config: string | null;
  chunkSeq: number;
  updatedAt: number;
  streamVersion: string | null;
  durableOffset: number;
  executor: GenerationExecutor;
  startedAt: number | null;
  cancelRequested: number;
} & Record<string, SqlStorageValue>;
type Dependency = {
  runId: string;
  summaryRunId: string;
  summaryId: string;
  payload: string;
} & Record<string, SqlStorageValue>;
type Failure = { error: string; issue?: ErrorIssue; status: number; code?: string; stage?: string };
const capacityError = (phase: 'write' | 'terminal') =>
  new ProviderError(DATABASE_LIMIT_MESSAGE, {
    stage: 'storage',
    occurredAt: Date.now(),
    code: 'CONVERSATION_STORAGE_CAPACITY',
    type: phase,
    message: DATABASE_LIMIT_MESSAGE,
  });
type Claim = {
  context: ChatInput[];
  config?: ProviderConfig;
  claimed: boolean;
  status: MessageStatus;
  streamVersion?: string;
  assistantId?: string;
};
type ToolRequestRow = {
  messageId: string;
  rootId: string;
  enabled: string;
  requestHash: string;
  payload: string;
} & Record<string, SqlStorageValue>;
type WorkflowRow = {
  rootId: string;
  conversationId: string;
  created: number;
  nextAt: number;
  attempts: number;
} & Record<string, SqlStorageValue>;

export class Conversation extends DurableObject<Env> {
  private meter?: GenerationMeter;
  private readonly subscribers: ConversationSubscribers;
  private readonly messages: ConversationMessages;
  private readonly journal: GenerationCheckpoints;
  private readonly tools!: ToolTaskJournal;
  private readonly activeTools = new Map<
    string,
    { abort: AbortController; result: Promise<ToolTaskState> }
  >();
  private activeGeneration?: ActiveGeneration;
  private deletedAt: number | null = null;
  private deletionCleaned = false;
  private searchFlush?: Promise<boolean>;
  private readonly activity?: ConversationActivityJournal;
  private activityFlush?: Promise<void>;
  private readonly titles?: ConversationTitles;
  private readonly completionOutbox: CompletionOutbox;
  private readonly accounting: UsageAccounting;
  private activeAlarmAt?: number;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.subscribers = new ConversationSubscribers(ctx, (packet, recipients) =>
      this.meter?.broadcast(packet, recipients),
    );
    ctx.storage.transactionSync(() =>
      initializeConversation(ctx.storage.sql, env.GENERATION_METRICS === '1'),
    );
    this.deletedAt =
      ctx.storage.sql
        .exec<{ deletedAt: number }>('SELECT deletedAt FROM conversation_deletion WHERE id = 1')
        .toArray()[0]?.deletedAt ?? null;
    this.deletionCleaned = this.deletedAt !== null;
    this.completionOutbox = new CompletionOutbox(this.query.bind(this));
    this.accounting = new UsageAccounting(
      this.query.bind(this),
      env,
      () => ctx.storage.sync(),
      () => !this.deletedAt,
    );
    if (!this.deletedAt)
      this.activity = new ConversationActivityJournal(
        this.query.bind(this),
        Date.now,
        () => !this.deletedAt,
      );
    this.journal = new GenerationCheckpoints(this.query.bind(this));
    this.messages = new ConversationMessages(
      this.query.bind(this),
      this.journal,
      (id) => this.run(id)?.config,
      (payload) => this.meter?.event(payload),
      this.activity,
    );
    // Reuse the existing parser checkpoint; never duplicate per-token accounting writes.
    ctx.storage.transactionSync(() =>
      this.accounting.recover(new Set(), (attempt) => {
        if (this.deletedAt || !attempt.messageId || !['chat', 'summary'].includes(attempt.kind))
          return;
        if (
          this.query(
            'SELECT messageId FROM message_web_tools WHERE messageId=?',
            attempt.messageId,
          ).toArray().length
        )
          return;
        return this.messages.message(attempt.messageId)?.streamState?.usage;
      }),
    );
    if (this.deletedAt && this.accounting.nextAlarm() != null) ctx.waitUntil(this.scheduleAlarm());
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // A new instance cannot resume an old upstream socket. Recover before serving any snapshot.
    if (!this.deletedAt) {
      ctx.storage.sql.exec(TITLE_JOBS_SCHEMA);
      this.titles = new ConversationTitles(this.query.bind(this), () => !this.deletedAt, Date.now, {
        start: async (job, config) => {
          await this.accounting.start(
            {
              id: `title:${job.conversationId}:${job.id}`,
              taskId: job.id,
              conversationId: job.conversationId,
              messageId: null,
              kind: 'title',
            },
            modelIdentity(config),
          );
          this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
        },
        finish: (job, state, status) => {
          this.ctx.storage.transactionSync(() =>
            this.accounting.finish(`title:${job.conversationId}:${job.id}`, {
              status,
              usage: state.usage,
              usageIsFinal: state.usageIsFinal && state.done && !state.failure,
            }),
          );
          this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
        },
      });
      ctx.storage.transactionSync(() => this.titles!.recover());
      this.tools = new ToolTaskJournal(this.query.bind(this));
      ctx.storage.transactionSync(() => this.tools.recover());
      for (const run of this.query<Run>(
        `SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId AND messages.runId = runs.id WHERE messages.status IN ('queued', 'running')`,
      ).toArray()) {
        const tool = this.tools.model(run.id);
        if (tool) {
          const state = this.tools.state(tool.rootId);
          if (state.status !== 'active') this.finish(run.id, state.status, state.error);
          else {
            const change = this.ctx.storage.transactionSync(() =>
              this.refreshToolMessage(tool.rootId, run.conversationId),
            );
            if (change) this.broadcast(change);
          }
        } else if (this.messages.rawMessage(run.assistantId)?.status === 'running')
          this.finishInterrupted(run);
      }
      if (
        this.query(
          `SELECT rootId FROM tool_workflows WHERE EXISTS (SELECT 1 FROM web_tool_tasks WHERE id = rootId AND status = 'active')
        OR EXISTS (SELECT 1 FROM web_tool_notifications WHERE web_tool_notifications.rootId = tool_workflows.rootId) LIMIT 1`,
        ).toArray().length
      )
        ctx.waitUntil(this.scheduleAlarm());
      if (
        this.activity?.nextAlarm() != null ||
        this.titles?.nextAlarm() != null ||
        this.completionOutbox.nextAlarm() != null ||
        this.accounting.nextAlarm() != null
      )
        ctx.waitUntil(this.scheduleAlarm());
    }
  }
  private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    statement: string,
    ...bindings: SqlStorageValue[]
  ) {
    try {
      return measuredQuery<T>(this.ctx.storage.sql, this.meter, statement, ...bindings);
    } catch (error) {
      const storage = storageErrorMessage(error);
      if (storage) throw new ProviderError(storage);
      throw error;
    }
  }
  generationMeasurements(): GenerationMeasurements | null {
    if (this.deletedAt) return null;
    if (this.env.GENERATION_METRICS !== '1') return null;
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM generation_measurements WHERE id = 1')
      .toArray()[0];
    return row ? (JSON.parse(row.payload) as GenerationMeasurements) : null;
  }
  backup(): BackupMessage[] {
    if (this.deletedAt) return [];
    return this.messages.all().map(backupMessage);
  }
  shareSourceVersion() {
    if (this.deletedAt) return null;
    return JSON.stringify(new ConversationState(this.query.bind(this)).current());
  }
  shareSourceResponse(headId: string) {
    if (this.deletedAt)
      return json({ error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED') }, 404);
    try {
      const projection = projectShare(this.messages.forHead(headId), headId);
      const version = this.shareSourceVersion();
      const encoder = new TextEncoder(),
        blocks = projection.blocks();
      let header = false,
        count = 0,
        ended = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!header) {
              header = true;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    version,
                    messageCount: projection.messageCount,
                    omittedAttachments: projection.omittedAttachments,
                  }) + '\n',
                ),
              );
              return;
            }
            const next = blocks.next();
            if (next.done) {
              if (ended) controller.close();
              else {
                ended = true;
                controller.enqueue(
                  encoder.encode(JSON.stringify({ complete: true, blockCount: count }) + '\n'),
                );
              }
            } else {
              count++;
              controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'));
            }
          },
          cancel() {
            blocks.return(undefined);
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } },
      );
    } catch {
      return json({ error: '请选择已完成的消息分支。', issue: problem('INVALID_REQUEST') }, 409);
    }
  }
  copySource(
    headId?: string,
  ): { messages: BackupMessage[]; settings: ConversationSettings } | Failure {
    if (this.deletedAt)
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    let messages = Array.from(this.messages.rows(), (row) => this.messages.decorate(row));
    if (headId !== undefined) {
      const head = messages.find((message) => message.id === headId);
      if (!head || head.deletedAt)
        return { error: '找不到这条消息。', issue: problem('NOT_FOUND'), status: 404 };
      try {
        const path = branchPath(messages, headId),
          ids = new Set(path.map(({ id }) => id));
        messages = [
          ...path,
          ...messages.filter(
            (message) =>
              message.summary &&
              !ids.has(message.id) &&
              message.summary.sourceIds.every((id) => ids.has(id)),
          ),
        ];
      } catch {
        return {
          error: '消息分支关系无效，无法复制。',
          issue: problem('INVALID_REQUEST'),
          status: 409,
        };
      }
    }
    // Read settings and the durable prefix together; never copy browser-only previews or start a generation.
    return {
      messages: messages.map((message) => backupMessage(this.messages.materialize(message))),
      settings: this.messages.settings(),
    };
  }
  copySourceResponse(headId?: string) {
    const result = this.copySource(headId);
    return json(result, 'error' in result ? result.status : 200);
  }
  settings(): ConversationSettings {
    return this.messages.settings();
  }
  async saveSettings(
    conversationId: string,
    settings: ConversationSettings,
  ): Promise<ConversationSettings | Failure> {
    if (this.deletedAt || (await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)))
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    const result = this.ctx.storage.transactionSync(() => {
      if (this.deletedAt)
        return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
      if (JSON.stringify(this.messages.settings()) === JSON.stringify(settings)) {
        // An explicit choice of inherited defaults still counts as configured.
        if (!this.query('SELECT id FROM conversation_settings WHERE id = 1').toArray().length)
          this.messages.writeSettings(settings);
        return null;
      }
      this.messages.writeSettings(settings);
      return this.messages.record([], undefined, settings);
    });
    if (result && 'error' in result) return result;
    if (result) this.broadcast(result);
    return settings;
  }
  restore(conversationId: string, backup: ConversationBackup): Snapshot | Failure {
    if (this.deletedAt)
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    if (this.query('SELECT id FROM messages LIMIT 1').toArray().length)
      return { error: '目标对话已有消息。', issue: problem('INVALID_REQUEST'), status: 409 };
    const plan = planConversationRestore(backup);
    if ('error' in plan) return plan;
    const { messages, settings, batches } = plan;
    const changes = this.ctx.storage.transactionSync(() => {
      for (const message of messages) {
        this.messages.insert(message);
        if (message.deletedAt)
          this.query('INSERT INTO message_deletions VALUES (?, ?)', message.id, message.deletedAt);
      }
      this.messages.writeSettings(settings);
      return batches.map((batch) => this.messages.record(batch, conversationId, settings));
    });
    for (const change of changes) this.broadcast(change);
    this.updateSearchSoon();
    return this.messages.snapshot();
  }
  async restoreResponse(conversationId: string, body: ReadableStream<Uint8Array>) {
    const backup = (await new Response(body).json()) as ConversationBackup;
    const result = this.restore(conversationId, backup);
    return json(result, 'error' in result ? result.status : 200);
  }
  private run(id: string): Run | undefined {
    return this.query<Run>('SELECT * FROM runs WHERE id = ?', id).toArray()[0];
  }
  snapshotPageResponse(after: number): Response {
    if (this.deletedAt)
      return json({ error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED') }, 410);
    return json(this.messages.page(after));
  }
  private capacityBytes(threshold: number) {
    const size = this.ctx.storage.sql.databaseSize;
    return size > threshold ? databaseUsage(this.ctx.storage.sql).usedBytes : size;
  }
  storageStats() {
    const sum = (table: string, expression: string) =>
      this.query<{ bytes: number }>(
        `SELECT COALESCE(SUM(${expression}), 0) AS bytes FROM ${table}`,
      ).one().bytes;
    return {
      databaseBytes: this.ctx.storage.sql.databaseSize,
      ...databaseUsage(this.ctx.storage.sql),
      limits: {
        admissionBytes: MAX_DATABASE_START_BYTES,
        writeBytes: MAX_DATABASE_WRITE_BYTES,
        maximumBytes: MAX_DATABASE_BYTES,
      },
      messages: this.query<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count,
      canonicalBytes:
        sum(
          'messages',
          'length(CAST(content AS BLOB)) + COALESCE(length(CAST(reasoning AS BLOB)), 0)',
        ) + sum('message_content_chunks', 'length(CAST(payload AS BLOB))'),
      checkpointBytes: sum('generation_checkpoints', 'length(CAST(state AS BLOB))'),
      privateStreamBytes: 0,
      activeTaskBytes: sum(
        'runs',
        'length(CAST(context AS BLOB)) + COALESCE(length(CAST(config AS BLOB)), 0)',
      ),
      idempotencyBytes: sum(
        'submissions',
        'length(CAST(fingerprint AS BLOB)) + length(CAST(result AS BLOB))',
      ),
    };
  }
  snapshotResponse(): Response {
    if (this.deletedAt)
      return json({ error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED') }, 410);
    // RPC transfers a Response body as a stream, keeping history decoding and JSON work out of the Free Worker.
    return json(this.messages.snapshot());
  }
  searchDocumentPage(after: number): SearchPage {
    if (this.deletedAt) return { documents: [], after, done: true };
    const rows = this.query<Row & { ordinal: number; version: number }>(
      `SELECT messages.*, messages.rowid AS ordinal, COALESCE(message_search_versions.version, 0) AS version, NULL AS generationResult
      FROM messages LEFT JOIN message_search_versions ON message_search_versions.messageId = messages.id WHERE messages.rowid > ? AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE message_summaries.messageId = messages.id) ORDER BY messages.rowid LIMIT 5`,
      after,
    ).toArray();
    const page = rows.slice(0, 4);
    return {
      documents: page
        .filter((row) => !isActive(row))
        .map((row) => this.messages.searchDocument(this.messages.decorate(row), row.version)),
      after: page.at(-1)?.ordinal ?? after,
      done: rows.length <= 4,
    };
  }
  private flushSearchIndex(): Promise<boolean> {
    if (this.searchFlush) return this.searchFlush;
    const flush = async () => {
      if (this.deletedAt) return true;
      const retry = this.query<{ attempts: number; nextAt: number }>(
        'SELECT attempts, nextAt FROM search_retry WHERE id = 1',
      ).toArray()[0];
      if (retry && retry.nextAt > Date.now()) return false;
      try {
        const pending = this.query<{ messageId: string; conversationId: string; version: number }>(
          'SELECT * FROM search_outbox ORDER BY version LIMIT 4',
        ).toArray();
        for (const item of pending) {
          const message = this.messages.rawMessage(item.messageId);
          if (!message || this.deletedAt) continue;
          await this.env.LIBRARY.getByName('personal').applySearchDocuments(item.conversationId, [
            this.messages.searchDocument(message, item.version),
          ]);
          if (this.deletedAt) return true;
          this.query(
            'DELETE FROM search_outbox WHERE messageId = ? AND version = ?',
            item.messageId,
            item.version,
          );
        }
        this.query('DELETE FROM search_retry WHERE id = 1');
        return true;
      } catch {
        if (this.deletedAt) return true;
        const attempts = (retry?.attempts ?? 0) + 1;
        this.query(
          'INSERT INTO search_retry VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET attempts = excluded.attempts, nextAt = excluded.nextAt',
          attempts,
          Date.now() + searchRetryDelay(attempts),
        );
        console.warn('EverChat search update will retry');
        return false;
      }
    };
    this.searchFlush = flush().finally(() => {
      this.searchFlush = undefined;
    });
    return this.searchFlush;
  }
  private updateSearchSoon() {
    this.ctx.waitUntil(
      (async () => {
        const success = await this.flushSearchIndex();
        await this.ctx.storage.transaction(async () => {
          if (
            this.deletedAt ||
            !this.query('SELECT messageId FROM search_outbox LIMIT 1').toArray().length
          )
            return;
          const next = success
              ? Date.now() + 1000
              : (this.query<{ nextAt: number }>(
                  'SELECT nextAt FROM search_retry WHERE id = 1',
                ).toArray()[0]?.nextAt ?? Date.now() + 30_000),
            alarm = await this.ctx.storage.getAlarm();
          if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
        });
      })(),
    );
  }
  private broadcast(change: DurableChange) {
    if (this.deletedAt) return;
    // Durable confirmations pass through the storage output gate; preview packets never acknowledge storage.
    this.subscribers.send(JSON.stringify(change.type === 'commit' ? commitAck(change) : change));
    if (change.type === 'change' && change.activity)
      this.ctx.waitUntil(
        (async () => {
          await this.flushActivity();
          await this.scheduleAlarm();
        })(),
      );
  }
  private flushActivity(): Promise<void> {
    if (this.deletedAt || !this.activity) return Promise.resolve();
    if (this.activityFlush) return this.activityFlush;
    const operation = this.activity.flush((id, activity) =>
      this.env.LIBRARY.getByName('personal').reportActivity(id, activity),
    );
    this.activityFlush = operation;
    void operation
      .finally(() => {
        if (this.activityFlush === operation) this.activityFlush = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private preview(batch: StreamBatch, target?: WebSocket) {
    if (this.deletedAt) return;
    this.subscribers.send(JSON.stringify({ type: 'preview', batch }), batch, target);
  }
  async reviseAssistant(
    conversationId: string,
    messageId: string,
    requestId: string,
    content: string,
  ): Promise<{ messageId: string } | Failure> {
    if (this.deletedAt || (await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)))
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    const accepted = this.ctx.storage.transactionSync<
      { messageId: string; change: Change } | { messageId: string } | Failure
    >(() => {
      if (this.deletedAt)
        return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
      const fingerprint = requestFingerprint(['assistant-edit', messageId, content.trim()]);
      const existing = this.query<{ fingerprint: string; result: string }>(
        'SELECT fingerprint, result FROM submissions WHERE id = ?',
        requestId,
      ).toArray()[0];
      if (existing)
        return existing.fingerprint === fingerprint
          ? (JSON.parse(existing.result) as { messageId: string })
          : {
              error: '此请求 ID 已用于另一条消息。',
              issue: problem('INVALID_REQUEST'),
              status: 409,
            };
      const original = this.messages.rawMessage(messageId);
      if (!original || original.deletedAt || original.role !== 'assistant' || original.summary)
        return { error: '找不到要编辑的回答。', issue: problem('NOT_FOUND'), status: 404 };
      if (
        this.query(
          "SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1",
        ).toArray().length
      )
        return {
          error: '请等待生成完成或先停止，再编辑消息。',
          issue: problem('CONVERSATION_BUSY'),
          status: 409,
        };
      if (!content.trim() || !messageTextFits(content.trim()))
        return { error: MESSAGE_TEXT_LIMIT_MESSAGE, issue: problem('MESSAGE_LIMIT'), status: 400 };
      if (this.capacityBytes(MAX_DATABASE_START_BYTES) > MAX_DATABASE_START_BYTES)
        return {
          error: DATABASE_LIMIT_MESSAGE,
          issue: problem('STORAGE_FULL'),
          status: 507,
          code: 'CONVERSATION_STORAGE_CAPACITY',
          stage: 'admission',
        };
      if (this.messages.count() >= MAX_MESSAGES)
        return {
          error: '此对话已达到消息数量保护上限，请新建对话。',
          issue: problem('OPERATION_BUSY'),
          status: 507,
        };
      const revision: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: messageParts(content.trim()),
        status: 'completed',
        createdAt: Date.now(),
        runId: null,
        parentId: original.parentId,
        revisionOf: original.id,
        error: null,
        providerId: original.providerId,
        model: original.model,
        modelName: original.modelName,
      };
      this.messages.insert(revision);
      const result = { messageId: revision.id };
      this.query(
        'INSERT INTO submissions VALUES (?, ?, ?)',
        requestId,
        fingerprint,
        JSON.stringify(result),
      );
      return {
        ...result,
        change: this.messages.record([this.messages.rawMessage(revision.id)!], conversationId),
      };
    });
    if ('change' in accepted) {
      this.broadcast(accepted.change);
      this.updateSearchSoon();
      return { messageId: accepted.messageId };
    }
    return accepted;
  }
  async deleteMessage(
    conversationId: string,
    messageId: string,
  ): Promise<{ deletedAt: number } | Failure> {
    if (this.deletedAt || (await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)))
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    const accepted = this.ctx.storage.transactionSync<
      { deletedAt: number; change: Change } | { deletedAt: number } | Failure
    >(() => {
      if (this.deletedAt)
        return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
      const original = this.messages.rawMessage(messageId);
      if (!original)
        return { error: '找不到要删除的消息。', issue: problem('NOT_FOUND'), status: 404 };
      if (original.deletedAt) return { deletedAt: original.deletedAt };
      if (
        this.query(
          "SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1",
        ).toArray().length
      )
        return {
          error: '请等待生成完成或先停止，再删除消息。',
          issue: problem('CONVERSATION_BUSY'),
          status: 409,
        };
      const deletedAt = Date.now();
      const affected = [
        original,
        ...Array.from(this.messages.rows(), (row) => this.messages.decorate(row)).filter(
          (message) => !message.deletedAt && message.summary?.sourceIds.includes(messageId),
        ),
      ];
      for (const message of affected) {
        this.journal.erase(message.id);
        this.query(
          'UPDATE messages SET content = ?, reasoning = NULL, error = NULL WHERE id = ?',
          '',
          message.id,
        );
        this.query('INSERT INTO message_deletions VALUES (?, ?)', message.id, deletedAt);
        this.query('DELETE FROM message_generations WHERE messageId = ?', message.id);
        this.query('DELETE FROM message_images WHERE messageId = ?', message.id);
        this.query('DELETE FROM message_files WHERE messageId = ?', message.id);
        const tool = this.toolRequest(message.id);
        if (tool) {
          this.query(
            'DELETE FROM tool_model_permits WHERE runId IN (SELECT runId FROM web_tool_models WHERE rootId = ?)',
            tool.rootId,
          );
          this.tools.erase(tool.rootId);
          this.query('DELETE FROM tool_workflows WHERE rootId = ?', tool.rootId);
          this.query('DELETE FROM message_web_tools WHERE messageId = ?', message.id);
        }
        if (message.runId)
          this.query('DELETE FROM generation_timings WHERE runId = ?', message.runId);
        // Keep request IDs so delayed retries cannot recreate deleted content, but erase their saved text.
        this.query(
          "UPDATE submissions SET fingerprint = '' WHERE json_extract(result, '$.userId') = ? OR json_extract(result, '$.assistantId') = ? OR json_extract(result, '$.messageId') = ?",
          message.id,
          message.id,
          message.id,
        );
      }
      const change = this.messages.record(
        affected.map((message) => this.messages.rawMessage(message.id)!),
        conversationId,
      );
      return { deletedAt, change };
    });
    if ('change' in accepted) {
      this.broadcast(accepted.change);
      this.updateSearchSoon();
      return { deletedAt: accepted.deletedAt };
    }
    return accepted;
  }
  async submit(
    conversationId: string,
    input: SubmitInput,
    config: ProviderConfig | null,
    automaticTitle: ProviderConfig | null = null,
  ): Promise<Submission | Failure> {
    if (this.deletedAt || (await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)))
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    const accepted = await this.ctx.storage.transaction<
      Submission | Failure | { result: Submission; change: Change }
    >(async () => {
      if (this.deletedAt)
        return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
      const fingerprint = requestFingerprint([
        input.content ?? null,
        input.retryOf ?? null,
        input.revisionOf ?? null,
        input.parentId ?? null,
        input.selection?.providerId ?? null,
        input.selection?.model ?? null,
        input.reasoningEffort ?? null,
        input.settings ?? null,
        input.summaryThrough ?? null,
        input.imageIds ?? null,
        input.fileIds ?? null,
        input.fileSelections ?? null,
        input.tools ?? null,
      ]);
      const duplicate = () => {
        const existing = this.query<{ fingerprint: string; result: string }>(
          'SELECT * FROM submissions WHERE id = ?',
          input.requestId,
        ).toArray()[0];
        if (!existing) return null;
        return existing.fingerprint === fingerprint
          ? (JSON.parse(existing.result) as Submission)
          : {
              error: '此请求 ID 已用于另一条消息。',
              issue: problem('INVALID_REQUEST'),
              status: 409,
            };
      };
      const existing = duplicate();
      if (existing) return existing;
      if (
        input.summaryThrough &&
        (input.content !== undefined ||
          input.retryOf ||
          input.revisionOf ||
          input.parentId !== undefined ||
          input.settings ||
          input.reasoningEffort ||
          input.imageIds !== undefined ||
          input.fileIds !== undefined ||
          input.fileSelections !== undefined ||
          input.tools !== undefined)
      )
        return {
          error: '摘要请求不能同时指定聊天内容或会话参数。',
          issue: problem('INVALID_REQUEST'),
          status: 400,
        };
      if (!config)
        return {
          error: '所选模型不可用，请配置供应商并启用模型。',
          issue: problem('MODEL_UNAVAILABLE'),
          status: 400,
        };
      if (input.tools) {
        try {
          assertWebToolSupport(config.modelMetadata, input.tools);
        } catch (error) {
          return {
            issue: issueOf(error),
            error: error instanceof Error ? error.message : '工具配置无效。',
            status: 400,
          };
        }
        if (!this.webToolsConfigured(input.tools, config.webTools))
          return {
            error: '尚未配置联网工具服务。',
            issue: problem('TOOL_NOT_CONFIGURED'),
            status: 400,
          };
        if (config.webTools) {
          const quota = await this.env.LIBRARY.getByName('personal').webToolSettings();
          if (quota.usedToday >= Math.min(quota.dailyLimit, config.webTools.dailyLimit))
            return { error: WEB_TOOL_QUOTA_ERROR, status: 429 };
        }
      }
      if (
        this.query(
          `SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1`,
        ).toArray().length
      )
        return {
          error: '这个对话正在生成回答，请等待完成或先停止。',
          issue: problem('CONVERSATION_BUSY'),
          status: 409,
        };
      if (this.capacityBytes(MAX_DATABASE_START_BYTES) > MAX_DATABASE_START_BYTES)
        return {
          error: DATABASE_LIMIT_MESSAGE,
          issue: problem('STORAGE_FULL'),
          status: 507,
          code: 'CONVERSATION_STORAGE_CAPACITY',
          stage: 'admission',
        };
      const messages = this.messages.forHead(
        input.summaryThrough ?? input.retryOf ?? input.revisionOf ?? input.parentId,
      );
      if (input.summaryThrough) {
        if (messages.length >= MAX_MESSAGES)
          return {
            error: '此对话已达到消息数量保护上限，请新建对话。',
            issue: problem('OPERATION_BUSY'),
            status: 507,
          };
        if (
          messages.filter((message) => message.summary && !message.deletedAt).length >=
          MAX_SUMMARIES
        )
          return {
            error: '摘要数量已达到容量上限，请删除旧摘要或新建对话。',
            issue: problem('OPERATION_BUSY'),
            status: 507,
          };
        let prepared;
        try {
          prepared = summaryGeneration(messages, input.summaryThrough, config);
        } catch (error) {
          return {
            issue: issueOf(error),
            error: error instanceof Error ? error.message : '无法构建摘要输入。',
            status: error instanceof ContextBudgetError ? 400 : 409,
          };
        }
        const pinned = await this.pinContextAttachments(conversationId, prepared.context);
        if (pinned) return pinned;
        const runId = crypto.randomUUID();
        const summary: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [],
          status: 'queued',
          createdAt: Date.now(),
          runId,
          parentId: input.summaryThrough,
          revisionOf: null,
          error: null,
          summary: prepared.coverage,
          providerId: prepared.config.providerId,
          model: prepared.config.model,
          modelName: prepared.config.modelName || prepared.config.model,
          streamVersion: STREAM_VERSION,
          durableOffset: 0,
          generation: { usage: {}, usageIsFinal: false, context: prepared.estimate },
        };
        this.messages.insert(summary);
        this.query(
          'INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
          runId,
          conversationId,
          summary.id,
          JSON.stringify(prepared.context),
          Date.now(),
          JSON.stringify(prepared.config),
          STREAM_VERSION,
          'do-v1',
        );
        const change = this.messages.record(
          [this.messages.rawMessage(summary.id)!],
          conversationId,
        );
        const result = {
          runId,
          userId: input.summaryThrough,
          assistantId: summary.id,
          activity: change.activity,
        };
        this.query(
          'INSERT INTO submissions VALUES (?, ?, ?)',
          input.requestId,
          fingerprint,
          JSON.stringify(result),
        );
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return { result, change };
      }
      const plan = planSubmissionParent(messages, input);
      if ('error' in plan) return plan;
      const { parent, previous, original, content, userParentId } = plan;
      const references = parent
        ? { value: messageImages(parent) }
        : input.imageIds?.length
          ? await this.env.LIBRARY.getByName('personal').imageReferences(
              conversationId,
              input.imageIds,
            )
          : { value: [] as ImagePart[] };
      if ('error' in references) return references;
      const images = references.value;
      const documents = parent
        ? { value: messageFiles(parent) }
        : input.fileIds?.length || input.fileSelections
          ? await this.env.LIBRARY.getByName('personal').documentReferences(
              conversationId,
              input.fileIds ?? [],
              input.fileSelections,
            )
          : { value: [] as DocumentPart[] };
      if ('error' in documents) return documents;
      const files = documents.value;
      if ((!content && !images.length && !files.length) || !messageTextFits(content))
        return {
          error: '请输入消息，正文须在 768 KiB 的存储保护大小以内。',
          issue: problem('REQUEST_TOO_LARGE'),
          status: 400,
        };
      const settings = input.settings ?? this.messages.settings();
      let generationConfig: ProviderConfig;
      try {
        generationConfig = applyConversationSettings(config, settings);
      } catch (error) {
        return {
          issue: issueOf(error),
          error: error instanceof Error ? error.message : '会话参数无效。',
          status: 400,
        };
      }
      const runId = crypto.randomUUID();
      let context: ChatInput[];
      let contextEstimate;
      let automatic: ReturnType<typeof summaryGeneration> | undefined;
      try {
        const built = prepareChatContext(
          messages,
          parent ? parent.parentId : userParentId,
          content,
          generationConfig,
          settings,
          images,
          files,
        );
        context = built.messages;
        contextEstimate = built.estimate;
        if (built.automatic) {
          if (messages.length + (parent ? 2 : 3) > MAX_MESSAGES)
            return {
              error: '此对话已达到消息数量保护上限，请新建对话。',
              issue: problem('OPERATION_BUSY'),
              status: 507,
            };
          if (
            messages.filter((message) => message.summary && !message.deletedAt).length >=
            MAX_SUMMARIES
          )
            return {
              error: '摘要数量已达到容量上限，请删除旧摘要或关闭自动压缩。',
              issue: problem('OPERATION_BUSY'),
              status: 507,
            };
          const summaryConfig = settings.autoCompression.model
            ? await this.env.LIBRARY.getByName('personal').providerConfig(
                settings.autoCompression.model,
              )
            : config;
          if (!summaryConfig)
            return {
              error: '自动压缩模型不可用，请启用所选模型或关闭自动压缩。',
              issue: problem('COMPRESSION_MODEL_UNAVAILABLE'),
              status: 400,
            };
          automatic = summaryGeneration(messages, built.automatic.throughId, summaryConfig);
        }
      } catch (error) {
        return error instanceof ContextBudgetError ||
          error instanceof ImageContextError ||
          error instanceof DocumentError
          ? { issue: issueOf(error), error: error.message, status: 400 }
          : {
              error: '消息分支关系无效，无法构建上下文。',
              issue: problem('INVALID_REQUEST'),
              status: 409,
            };
      }
      const pinned = await this.pinContextAttachments(conversationId, [
        ...context,
        ...(automatic?.context ?? []),
      ]);
      if (pinned) return pinned;
      const user: Message = parent ?? {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [...messageParts(content), ...images, ...files],
        status: 'completed',
        createdAt: Date.now(),
        runId: null,
        parentId: userParentId,
        revisionOf: original?.id ?? null,
        error: null,
      };
      const assistant: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [],
        status: 'queued',
        createdAt: Date.now(),
        runId,
        parentId: user.id,
        revisionOf: previous?.id ?? null,
        error: null,
        providerId: generationConfig.providerId,
        model: generationConfig.model,
        modelName: generationConfig.modelName || generationConfig.model,
        streamVersion: STREAM_VERSION,
        durableOffset: 0,
        generation: {
          usage: {},
          usageIsFinal: false,
          ...(!automatic ? { context: contextEstimate } : {}),
        },
      };
      const initializeSettings =
        messages.length === 0 &&
        !this.query('SELECT id FROM conversation_settings WHERE id = 1').toArray().length;
      if (messages.length === 0) this.titles?.initialize(automaticTitle);
      if (initializeSettings) {
        this.messages.writeSettings(settings);
      }
      if (!parent) this.messages.insert(user);
      const summary = automatic ? this.queueSummary(conversationId, automatic, true) : undefined;
      this.messages.insert(assistant);
      if (input.tools)
        this.query(
          'INSERT INTO message_web_tools VALUES (?, ?, ?, ?, ?)',
          assistant.id,
          input.requestId,
          JSON.stringify(input.tools),
          createHash('sha256').update(fingerprint).digest('hex'),
          JSON.stringify({
            status: 'active',
            round: 0,
            calls: [],
            reasoningBreaks: [],
          } satisfies PublicToolTask),
        );
      this.query(
        'INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        runId,
        conversationId,
        assistant.id,
        JSON.stringify(automatic ? [] : context),
        Date.now(),
        JSON.stringify(generationConfig),
        STREAM_VERSION,
        'do-v1',
      );
      if (summary)
        this.query(
          'INSERT INTO run_dependencies VALUES (?, ?, ?, ?)',
          runId,
          summary.runId!,
          summary.id,
          JSON.stringify({
            parentId: parent ? parent.parentId : userParentId,
            content,
            settings,
            images,
            files,
          }),
        );
      const change = this.messages.record(
        [
          ...(parent ? [] : [this.messages.rawMessage(user.id)!]),
          ...(summary ? [this.messages.rawMessage(summary.id)!] : []),
          this.messages.rawMessage(assistant.id)!,
        ],
        conversationId,
        messages.length === 0 ? this.messages.settings() : undefined,
      );
      const result = {
        runId,
        userId: user.id,
        assistantId: assistant.id,
        ...(summary ? { summaryId: summary.id } : {}),
        activity: change.activity,
      };
      this.query(
        'INSERT INTO submissions VALUES (?, ?, ?)',
        input.requestId,
        fingerprint,
        JSON.stringify(result),
      );
      // The outbox, input/configuration and its alarm commit together before acceptance.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return { result, change };
    });
    if ('change' in accepted) {
      this.broadcast(accepted.change);
      this.updateSearchSoon();
      return accepted.result;
    }
    return accepted;
  }
  private queueSummary(
    conversationId: string,
    prepared: ReturnType<typeof summaryGeneration>,
    automatic: boolean,
  ) {
    const runId = crypto.randomUUID();
    const summary: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [],
      status: 'queued',
      createdAt: Date.now(),
      runId,
      parentId: prepared.coverage.throughId,
      revisionOf: null,
      error: null,
      summary: { ...prepared.coverage, ...(automatic ? { automatic: true } : {}) },
      providerId: prepared.config.providerId,
      model: prepared.config.model,
      modelName: prepared.config.modelName || prepared.config.model,
      streamVersion: STREAM_VERSION,
      durableOffset: 0,
      generation: { usage: {}, usageIsFinal: false, context: prepared.estimate },
    };
    this.messages.insert(summary);
    this.query(
      'INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      runId,
      conversationId,
      summary.id,
      JSON.stringify(prepared.context),
      Date.now(),
      JSON.stringify(prepared.config),
      STREAM_VERSION,
      'do-v1',
    );
    return summary;
  }
  protected webToolsConfigured(
    _enabled: readonly WebToolName[],
    service?: WebToolServiceConfig,
  ): boolean {
    return Boolean(service?.apiKey);
  }
  protected fetchWebTool(...args: Parameters<WebToolFetch>) {
    return fetch(...args);
  }
  protected async executeWebTool(
    call: WebToolCall,
    signal: AbortSignal,
    service?: WebToolServiceConfig,
    beforeRequest?: () => Promise<void>,
  ): Promise<WebToolOutcome> {
    return service
      ? executeWebTool(service, call, signal, async (request) => {
          await beforeRequest?.();
          return this.fetchWebTool(request);
        })
      : {
          id: call.id,
          name: call.name,
          status: 'failed',
          error: '尚未配置联网工具服务。',
          issue: problem('TOOL_NOT_CONFIGURED'),
        };
  }
  protected createWebToolWorkflow(params: ToolWorkflowParams) {
    return this.env.WEB_TOOLS.create({
      id: toolWorkflowId(params.conversationId, params.taskId),
      params,
    });
  }
  protected async notifyWebToolWorkflow(taskId: string, round: number) {
    const dispatch = this.query<WorkflowRow>(
      'SELECT * FROM tool_workflows WHERE rootId = ?',
      taskId,
    ).one();
    const instance = await this.env.WEB_TOOLS.get(toolWorkflowId(dispatch.conversationId, taskId));
    await instance.sendEvent({ type: `model-${round}`, payload: { taskId, round } });
  }
  private toolRequest(messageId: string) {
    return this.query<ToolRequestRow>(
      'SELECT * FROM message_web_tools WHERE messageId = ?',
      messageId,
    ).toArray()[0];
  }
  private refreshToolMessage(rootId: string, conversationId?: string): Change | null {
    const request = this.writeToolTask(rootId, this.tools.publicTask(rootId));
    return request
      ? this.messages.record([this.messages.message(request.messageId)!], conversationId)
      : null;
  }
  private writeToolTask(
    rootId: string,
    task: PublicToolTask,
    boundary?: ReasoningBreak,
    reasoning?: string,
  ) {
    const request = this.query<ToolRequestRow>(
      'SELECT * FROM message_web_tools WHERE rootId = ?',
      rootId,
    ).toArray()[0];
    if (!request) return null;
    const previous = JSON.parse(request.payload) as PublicToolTask;
    const payload = JSON.stringify(
      updateToolTask(
        previous,
        task,
        reasoning ?? messageText(this.messages.rawMessage(request.messageId)!, 'reasoning'),
        boundary,
      ),
    );
    if (payload === request.payload) return null;
    this.query('UPDATE message_web_tools SET payload = ? WHERE rootId = ?', payload, rootId);
    return request;
  }
  private initializeToolTasks() {
    for (const request of this.query<ToolRequestRow>(
      `SELECT message_web_tools.* FROM message_web_tools JOIN messages ON messages.id = messageId
      WHERE messages.status = 'queued' AND NOT EXISTS (SELECT 1 FROM web_tool_tasks WHERE web_tool_tasks.id = rootId)
      AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE run_dependencies.runId = messages.runId)`,
    ).toArray()) {
      const message = this.messages.rawMessage(request.messageId)!,
        run = this.run(message.runId!)!;
      try {
        this.ctx.storage.transactionSync(() => {
          const estimate = message.generation?.context;
          if (!run.config || !estimate)
            throw new ProviderError('工具任务缺少已保存的配置或上下文预算。');
          this.tools.create(
            {
              id: request.rootId,
              runId: run.id,
              messageId: message.id,
              requestHash: request.requestHash,
              enabled: JSON.parse(request.enabled),
              inputBudget: estimate.inputBudget,
              initialTokens: estimate.totalTokens,
            },
            JSON.parse(run.config),
          );
          this.query(
            'INSERT INTO tool_workflows(rootId, conversationId, nextAt) VALUES (?, ?, ?)',
            request.rootId,
            run.conversationId,
            Date.now(),
          );
        });
      } catch (error) {
        this.finish(
          run.id,
          'failed',
          error instanceof Error ? error.message : '无法登记工具任务。',
        );
      }
    }
  }
  private expireToolTasks() {
    this.ctx.storage.transactionSync(() => this.tools.expire());
    for (const row of this.query<{
      runId: string;
      status: 'completed' | 'failed' | 'cancelled';
      error: string | null;
    }>(
      `SELECT messages.runId, web_tool_tasks.status, web_tool_tasks.error
      FROM message_web_tools JOIN web_tool_tasks ON web_tool_tasks.id = rootId JOIN messages ON messages.id = messageId
      WHERE web_tool_tasks.status != 'active' AND messages.status IN ('queued', 'running')`,
    ).toArray())
      this.finish(row.runId, row.status, row.error);
  }
  private async flushToolWorkflows() {
    for (const row of this.query<WorkflowRow>(
      `SELECT tool_workflows.* FROM tool_workflows JOIN web_tool_tasks ON web_tool_tasks.id = rootId
      WHERE created = 0 AND status = 'active' AND nextAt <= ? LIMIT 2`,
      Date.now(),
    ).toArray()) {
      try {
        try {
          await this.createWebToolWorkflow({
            conversationId: row.conversationId,
            taskId: row.rootId,
          });
        } catch {
          const instance = await this.env.WEB_TOOLS.get(
              toolWorkflowId(row.conversationId, row.rootId),
            ),
            state = await instance.status();
          if (['errored', 'terminated', 'complete'].includes(state.status)) {
            await this.failToolTask(row.rootId);
            continue;
          }
        }
        if (this.deletedAt) return;
        this.query('UPDATE tool_workflows SET created = 1 WHERE rootId = ?', row.rootId);
      } catch {
        if (this.deletedAt) return;
        this.query(
          'UPDATE tool_workflows SET attempts = attempts + 1, nextAt = ? WHERE rootId = ?',
          Date.now() + Math.min(30_000, 5000 * 2 ** Math.min(row.attempts, 3)),
          row.rootId,
        );
      }
    }
    for (const notification of this.tools.notifications()) {
      const dispatch = this.query<WorkflowRow>(
        'SELECT * FROM tool_workflows WHERE rootId = ?',
        notification.rootId,
      ).toArray()[0];
      if (!dispatch?.created) {
        if (this.tools.state(notification.rootId).status !== 'active')
          this.tools.acknowledge(notification.rootId, notification.round);
        else this.tools.deferNotification(notification.rootId, notification.round);
        continue;
      }
      try {
        await this.notifyWebToolWorkflow(notification.rootId, notification.round);
        if (this.deletedAt) return;
        this.tools.acknowledge(notification.rootId, notification.round);
      } catch {
        if (this.deletedAt) return;
        if (this.tools.state(notification.rootId).status !== 'active') {
          const status = await this.env.WEB_TOOLS.get(
            toolWorkflowId(dispatch.conversationId, notification.rootId),
          )
            .then((instance) => instance.status())
            .catch(() => null);
          if (status && ['complete', 'errored', 'terminated'].includes(status.status)) {
            this.tools.acknowledge(notification.rootId, notification.round);
            continue;
          }
        }
        this.tools.deferNotification(notification.rootId, notification.round);
      }
    }
  }
  private async scheduleAlarm(searchSuccess = false) {
    await this.ctx.storage.transaction(async () => {
      const usageAt = this.accounting.nextAlarm();
      if (this.deletedAt) {
        if (usageAt != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, usageAt));
        else await this.ctx.storage.deleteAlarm();
        return;
      }
      const times: number[] = usageAt == null ? [] : [Math.max(Date.now() + 1000, usageAt)];
      if (this.activeGeneration)
        times.push(Math.max(Date.now() + 1000, this.activeAlarmAt ?? Date.now() + 30_000));
      else if (
        this.query(
          `SELECT messages.id FROM messages WHERE messages.status IN ('queued', 'running')
        AND (NOT EXISTS (SELECT 1 FROM message_web_tools WHERE messageId = messages.id) OR
          EXISTS (SELECT 1 FROM tool_model_permits WHERE runId = messages.runId) OR
          (EXISTS (SELECT 1 FROM message_web_tools WHERE messageId = messages.id) AND NOT EXISTS (SELECT 1 FROM web_tool_models WHERE runId = messages.runId)
            AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE runId = messages.runId))) LIMIT 1`,
        ).toArray().length
      )
        times.push(Date.now() + 1000);
      const workflow = this.query<{ next: number | null }>(
        `SELECT MIN(nextAt) AS next FROM tool_workflows JOIN web_tool_tasks ON web_tool_tasks.id = rootId WHERE created = 0 AND status = 'active'`,
      ).one().next;
      if (workflow !== null) times.push(workflow);
      const tools = this.tools.nextAlarm();
      if (tools !== null) times.push(tools);
      const title = this.titles?.nextAlarm();
      if (title != null && !this.activeGeneration) times.push(Math.max(Date.now() + 1000, title));
      const activity = this.activity?.nextAlarm();
      if (activity != null) times.push(activity);
      const completion = this.completionOutbox.nextAlarm();
      if (completion != null) times.push(completion);
      if (this.query('SELECT messageId FROM search_outbox LIMIT 1').toArray().length)
        times.push(
          searchSuccess
            ? Date.now() + 1000
            : (this.query<{ nextAt: number }>(
                'SELECT nextAt FROM search_retry WHERE id = 1',
              ).toArray()[0]?.nextAt ?? Date.now() + 30_000),
        );
      if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
      else await this.ctx.storage.deleteAlarm();
    });
  }
  toolTaskState(taskId: string): ToolTaskState {
    if (
      this.deletedAt ||
      !this.query('SELECT id FROM web_tool_tasks WHERE id = ?', taskId).toArray().length
    )
      return {
        id: taskId,
        status: 'cancelled',
        round: 0,
        deadline: 0,
        modelRequests: 0,
        toolRequests: 0,
        runId: '',
        messageId: '',
        phase: 'cancelled',
        calls: [],
        error: '这个工具任务已删除。',
        issue: problem('INVALID_REQUEST'),
      };
    this.expireToolTasks();
    return this.tools.state(taskId);
  }
  async scheduleToolModel(taskId: string, round: number): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId);
    if (state.status !== 'active') return state;
    if (!Number.isSafeInteger(round) || round < 0 || round > state.round + 1)
      throw new ProviderError('工具模型轮次无效。');
    let change: Change | null;
    try {
      change = this.ctx.storage.transactionSync(() => {
        if (round === state.round + 1) {
          const previous = this.run(state.runId)!;
          if (!previous.config) throw new ProviderError('工具续接配置不存在。');
          const runId = crypto.randomUUID();
          this.tools.queueModel(taskId, round, runId, state.messageId, JSON.parse(previous.config));
          this.query(
            'INSERT INTO runs(id, conversationId, assistantId, context, updatedAt, config, streamVersion) VALUES (?, ?, ?, ?, ?, ?, ?)',
            runId,
            previous.conversationId,
            state.messageId,
            previous.context,
            Date.now(),
            previous.config,
            STREAM_VERSION,
          );
          this.query("UPDATE runs SET config = NULL, context = '[]' WHERE id = ?", previous.id);
          this.query(
            'UPDATE messages SET runId = ?, status = ?, streamVersion = ?, durableOffset = 0 WHERE id = ?',
            runId,
            'queued',
            STREAM_VERSION,
            state.messageId,
          );
        }
        const current = this.tools.state(taskId);
        if (round !== current.round || current.phase !== 'queued') return null;
        const message = this.messages.rawMessage(current.messageId)!,
          estimate = message.generation?.context;
        if (!estimate) throw new ProviderError('工具任务缺少上下文估算。');
        const planned = this.tools.model(current.runId)!.plannedTokens;
        this.query(
          'UPDATE message_generations SET payload = ? WHERE messageId = ?',
          JSON.stringify({
            ...message.generation,
            context: {
              ...estimate,
              toolTokens: planned - (estimate.totalTokens - (estimate.toolTokens ?? 0)),
              totalTokens: planned,
            },
          }),
          current.messageId,
        );
        this.query(
          'INSERT INTO tool_model_permits VALUES (?) ON CONFLICT DO NOTHING',
          current.runId,
        );
        this.writeToolTask(taskId, this.tools.publicTask(taskId));
        return this.messages.record([this.messages.message(state.messageId)!]);
      });
    } catch (error) {
      this.finish(
        state.runId,
        'failed',
        error instanceof Error ? error.message : '无法登记下一工具模型步骤。',
      );
      await this.scheduleAlarm();
      return this.toolTaskState(taskId);
    }
    if (change) this.broadcast(change);
    await this.scheduleAlarm();
    await this.ctx.storage.sync();
    return this.toolTaskState(taskId);
  }
  async runWebTool(taskId: string, callId: string): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId);
    if (state.status !== 'active') return state;
    const key = `${taskId}:${callId}`,
      existing = this.activeTools.get(key);
    if (existing) return existing.result;
    const claimed = this.ctx.storage.transactionSync(() => this.tools.claimTool(taskId, callId));
    if (!claimed) return this.tools.state(taskId);
    const usageId = `web:${createHash('sha256')
      .update(JSON.stringify([this.run(state.runId)!.conversationId, taskId, callId]))
      .digest('hex')}`;
    const abort = new AbortController(),
      call = this.tools.publicCalls(state.runId).find((item) => item.call.id === callId)!.call;
    const change = this.ctx.storage.transactionSync(() => this.refreshToolMessage(taskId));
    if (change) this.broadcast(change);
    const result = (async () => {
      const timer = setTimeout(
        () => abort.abort(),
        Math.max(1, Math.min(15_000, state.deadline - Date.now())),
      );
      try {
        await this.ctx.storage.sync();
        const before = this.toolTaskState(taskId);
        if (before.status !== 'active') return before;
        const service = (JSON.parse(this.run(state.runId)!.config!) as ProviderConfig).webTools;
        let stopError: string | undefined;
        let outcome: WebToolOutcome;
        try {
          if (service) {
            const identity = createHash('sha256')
              .update(JSON.stringify([this.run(state.runId)!.conversationId, taskId, callId]))
              .digest('hex');
            const budget = await this.env.LIBRARY.getByName('personal').claimWebToolRequest(
              identity,
              service.dailyLimit,
            );
            if ('error' in budget) stopError = budget.error;
          }
          abort.signal.throwIfAborted();
          outcome = stopError
            ? { id: call.id, name: call.name, status: 'failed', error: stopError }
            : await this.executeWebTool(call, abort.signal, service, async () => {
                const provider = service!.provider;
                await this.accounting.start(
                  {
                    id: usageId,
                    taskId,
                    conversationId: this.run(state.runId)!.conversationId,
                    messageId: this.run(state.runId)!.assistantId,
                    kind: call.name,
                  },
                  {
                    providerId: `web:${provider}`,
                    providerName: provider === 'deepseek' ? 'DeepSeek 联网' : 'Tavily',
                    protocol: provider,
                    model: call.name,
                    modelName: call.name,
                  },
                );
                this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
              });
          stopError ??= terminalWebToolError(outcome);
        } catch {
          outcome = {
            id: call.id,
            name: call.name,
            status: 'failed',
            error: '联网工具执行失败或超时。',
            issue: problem('REQUEST_TIMEOUT'),
          };
        }
        this.ctx.storage.transactionSync(() =>
          this.accounting.finish(usageId, {
            status: abort.signal.aborted
              ? 'cancelled'
              : outcome.status === 'completed'
                ? 'completed'
                : 'failed',
            usage: {},
            usageIsFinal: outcome.status === 'completed',
            httpStatus: outcome.status === 'failed' ? outcome.failure?.httpStatus : undefined,
          }),
        );
        this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
        const current = this.toolTaskState(taskId);
        if (current.status !== 'active') return current;
        const update = this.ctx.storage.transactionSync(() => {
          try {
            this.tools.finishTool(taskId, callId, outcome);
          } catch {
            this.tools.finishTool(taskId, callId, {
              id: call.id,
              name: call.name,
              status: 'failed',
              error: '联网工具返回无效结果。',
              issue: problem('INVALID_REQUEST'),
            });
          }
          if (stopError) this.tools.stop(taskId, 'failed', stopError);
          return this.refreshToolMessage(taskId);
        });
        if (update) this.broadcast(update);
        if (stopError) {
          this.finish(state.runId, 'failed', stopError);
          // Unlike a model's Alarm, this RPC has no outer Alarm cleanup. The
          // terminal notification must replace the old root-deadline alarm.
          await this.scheduleAlarm();
        }
        await this.ctx.storage.sync();
        return this.toolTaskState(taskId);
      } finally {
        clearTimeout(timer);
        abort.abort();
        this.activeTools.delete(key);
      }
    })();
    this.activeTools.set(key, { abort, result });
    return result;
  }
  async failToolTask(taskId: string): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId);
    if (state.status === 'active')
      this.finish(state.runId, 'failed', '工具编排中断。已保留保存内容，请主动重新生成。');
    await this.scheduleAlarm();
    return this.toolTaskState(taskId);
  }
  async alarm() {
    await this.accounting.deliver();
    if (this.deletedAt) {
      await this.scheduleAlarm();
      return;
    }
    await this.flushCompletions();
    await this.flushActivity();
    const searchSuccess = await this.flushSearchIndex();
    // Retrying lifecycle reports must not start another upstream while a model is live.
    if (this.activeGeneration) {
      await this.flushToolWorkflows();
      await this.scheduleAlarm(searchSuccess);
      return;
    }
    if (
      this.query(
        "SELECT messages.id FROM message_web_tools JOIN messages ON messages.id = messageId WHERE messages.status IN ('queued', 'running') LIMIT 1",
      ).toArray().length
    )
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    this.expireToolTasks();
    this.initializeToolTasks();
    await this.flushToolWorkflows();
    for (const run of this.query<Run>(
      `SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE run_dependencies.runId = runs.id)`,
    ).toArray()) {
      if (this.messages.rawMessage(run.assistantId)?.runId !== run.id) continue;
      if (
        this.toolRequest(run.assistantId) &&
        !this.query('SELECT runId FROM tool_model_permits WHERE runId = ?', run.id).toArray().length
      )
        continue;
      const deletion = await this.env.LIBRARY.getByName('personal').deletedAt(run.conversationId);
      if (this.deletedAt) return;
      if (this.activeGeneration) {
        await this.scheduleAlarm(searchSuccess);
        return;
      }
      if (deletion) {
        await this.deleteConversation(deletion);
        return;
      }
      const message = this.messages.rawMessage(run.assistantId)!;
      if (message.status === 'running') this.finishInterrupted(run);
      else if (run.cancelRequested) this.finish(run.id, 'cancelled');
      else {
        const claim = this.claim(run.id);
        if (claim?.claimed) await this.runInObject(run.id, claim);
      }
    }
    await this.flushToolWorkflows();
    // Acceptance and cleanup both use transactions so cleanup cannot erase a new task's alarm.
    await this.flushActivity();
    const titleWork = this.titles?.step(
      this.env.LIBRARY.getByName('personal'),
      () => this.ctx.storage.sync(),
      (config, input, signal, beforeRequest) =>
        this.openModelStream(config, input, signal, undefined, undefined, undefined, beforeRequest),
      () =>
        Boolean(
          this.activeGeneration ||
          this.query(
            "SELECT id FROM messages WHERE status IN ('queued','running') LIMIT 1",
          ).toArray().length,
        ),
    );
    if (titleWork) this.ctx.waitUntil(titleWork.finally(() => this.scheduleAlarm()));
    await this.scheduleAlarm(searchSuccess);
  }
  private async flushCompletions() {
    if (this.deletedAt) return;
    await this.ctx.storage.sync();
    await this.completionOutbox.flush((completion) =>
      this.env.LIBRARY.getByName('personal').answerCompleted(completion),
    );
  }
  async generateTitle(conversationId: string, requestId: string) {
    if (this.deletedAt)
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    if (this.titles?.get(requestId)) return { id: requestId };
    const target = await this.env.LIBRARY.getByName('personal').titleTarget(conversationId);
    if (this.deletedAt || !target)
      return { error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED'), status: 410 };
    if (!target.config)
      return {
        error: '请在设置中选择可用的标题模型。',
        issue: problem('INVALID_REQUEST'),
        status: 400,
      };
    const question = this.query<{ id: string }>(
      "SELECT id FROM messages WHERE role='user' AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=messages.id) ORDER BY rowid LIMIT 1",
    ).toArray()[0];
    const answer = this.query<{ id: string }>(
      "SELECT id FROM messages WHERE role='assistant' AND status='completed' AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE messageId=messages.id) AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE id=messages.id) ORDER BY rowid LIMIT 1",
    ).toArray()[0];
    if (!question || !answer)
      return {
        error: '完成一条回答后再生成标题。',
        issue: problem('INVALID_REQUEST'),
        status: 409,
      };
    const result = this.ctx.storage.transactionSync(() =>
      this.titles!.enqueue(
        conversationId,
        requestId,
        target.config!,
        messageText(this.messages.message(question.id)!),
        messageText(this.messages.message(answer.id)!),
        false,
        target.version,
      ),
    );
    if (!('error' in result)) await this.scheduleAlarm();
    return result;
  }
  private finishInterrupted(run: Run) {
    this.finish(
      run.id,
      'failed',
      run.cancelRequested
        ? '停止过程中后台执行被中断。已保留最近检查点，请主动重新生成。'
        : '后台执行被中断。已保留最近检查点，为避免重复计费，请主动重新生成。',
    );
  }
  private async pinContextAttachments(
    conversationId: string,
    context: ChatInput[],
  ): Promise<Failure | null> {
    const images = context.flatMap((message) => message.images ?? []);
    const files = context.flatMap((message) => message.files ?? []);
    if (!images.length && !files.length) return null;
    const result = await this.env.LIBRARY.getByName('personal').pinAttachments(
      conversationId,
      images,
      files,
    );
    return 'error' in result ? result : null;
  }
  usesAttachment(id: string): boolean {
    if (this.deletedAt) return false;
    const needle = JSON.stringify({ attachmentId: id }).slice(1, -1);
    return Boolean(
      this.query(
        'SELECT messageId FROM message_images WHERE instr(payload, ?) > 0 LIMIT 1',
        needle,
      ).toArray().length ||
      this.query(
        'SELECT messageId FROM message_files WHERE instr(payload, ?) > 0 LIMIT 1',
        needle,
      ).toArray().length ||
      this.query(
        "SELECT runs.id FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running') AND instr(runs.context, ?) > 0 LIMIT 1",
        needle,
      ).toArray().length,
    );
  }
  protected openModelStream(...args: Parameters<typeof openProviderStream>) {
    return openProviderStream(...args);
  }
  private async runInObject(runId: string, claim: Claim) {
    const toolModel = this.tools.model(runId),
      deadline = toolModel ? this.tools.state(toolModel.rootId).deadline : Date.now() + 14 * 60_000;
    const abort = new AbortController();
    const active: ActiveGeneration = {
      runId,
      abort,
      cancelled: false,
      buffer: new GenerationBuffer(
        runId,
        claim.assistantId!,
        (batches) => {
          const saved = this.commit(runId, batches);
          if (saved) {
            const barrier = (active.persistence ?? Promise.resolve()).then(() =>
              this.ctx.storage.sync(),
            );
            active.persistence = barrier;
            void barrier.then(
              () => {
                if (active.persistence === barrier) active.persistence = undefined;
              },
              (error) => {
                active.failure =
                  error instanceof Error ? error : new Error('Generation persistence failed');
                abort.abort();
              },
            );
          }
          return saved;
        },
        (batch) => this.preview(batch),
      ),
    };
    this.activeGeneration = active;
    this.activeAlarmAt = toolModel ? deadline : Date.now() + 15 * 60_000;
    const timeout = setTimeout(
      () => abort.abort(),
      Math.max(1, Math.min(14 * 60_000, deadline - Date.now())),
    );
    try {
      // A surviving watchdog or alarm retry will finish an orphaned running task, never replay it.
      await this.scheduleAlarm();
      await this.ctx.storage.sync();
      if (active.cancelled || abort.signal.aborted) throw new GenerationCancelled();
      if (!claim.config) throw new ProviderError('此任务缺少已保存的供应商配置，请主动重新生成。');
      active.timer = setInterval(() => {
        if (active.cancelled || active.persistence) return;
        try {
          active.buffer.tick();
        } catch (error) {
          active.failure =
            error instanceof Error ? error : new Error('Generation persistence failed');
          abort.abort();
        }
      }, 100);
      this.query('INSERT INTO generation_timings VALUES (?, ?, NULL)', runId, Date.now());
      const observeOutput = (receivedAt: number) => {
        if (!this.deletedAt && !active.cancelled)
          this.query(
            'UPDATE generation_timings SET firstTokenAt = ? WHERE runId = ?',
            receivedAt,
            runId,
          );
      };
      const body = await this.openModelStream(
        claim.config,
        claim.context,
        abort.signal,
        async (image) => {
          return loadGenerationImage(
            this.env.LIBRARY.getByName('personal'),
            this.run(runId)!.conversationId,
            image,
          );
        },
        async (file) => {
          return loadGenerationDocument(
            this.env.LIBRARY.getByName('personal'),
            this.run(runId)!.conversationId,
            file,
          );
        },
        toolModel
          ? {
              enabled: this.tools.enabled(toolModel.rootId),
              exchanges: this.tools.exchanges(toolModel.rootId, toolModel.round, claim.config),
            }
          : undefined,
        async () => {
          const run = this.run(runId)!;
          await this.accounting.start(
            {
              id: `model:${runId}`,
              taskId: runId,
              conversationId: run.conversationId,
              messageId: run.assistantId,
              kind: this.messages.message(run.assistantId)?.summary ? 'summary' : 'chat',
              answer:
                !this.messages.message(run.assistantId)?.summary &&
                (!toolModel || toolModel.round === 0),
            },
            modelIdentity(claim.config!),
          );
          if (!this.deletedAt)
            this.query(
              'UPDATE generation_timings SET providerStartedAt=? WHERE runId=?',
              Date.now(),
              runId,
            );
          this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
        },
        observeOutput,
      );
      await consumeModelStream(body, active, (bytes) => active.buffer.add(bytes));
      active.buffer.flush();
      await active.persistence;
      const turn = toolModel && !active.cancelled ? body.toolTurn : undefined;
      this.finish(runId, active.cancelled ? 'cancelled' : 'completed', null, turn);
    } catch (error) {
      active.endedAt ??= Date.now();
      let failure = active.failure ?? error;
      let tailFailed = false;
      try {
        active.buffer.flush();
        await active.persistence;
      } catch (saveError) {
        if (!(saveError instanceof GenerationCancelled)) {
          failure = saveError;
          tailFailed = true;
        }
      }
      const cancelled = active.cancelled && !tailFailed;
      this.finish(
        runId,
        cancelled ? 'cancelled' : 'failed',
        cancelled
          ? null
          : toolModel && Date.now() >= deadline
            ? '工具任务超过 10 分钟期限，未启动后续步骤。'
            : failure instanceof ProviderError || failure instanceof StreamParseError
              ? failure.message
              : '生成中断或无法保存尾部。已保留最近检查点，请主动重新生成。',
        undefined,
        cancelled
          ? undefined
          : failure instanceof ProviderError && failure.details
            ? failure.details
            : providerFailure(
                claim.config,
                failure instanceof StreamParseError ? 'protocol' : 'stream',
                failure instanceof ProviderError || failure instanceof StreamParseError
                  ? failure.message
                  : undefined,
                { secrets: claim.context.map((message) => message.content) },
              ),
        cancelled ? undefined : issueOf(failure, 'GENERATION_INTERRUPTED'),
        !active.cancelled && !active.failure && !tailFailed,
      );
    } finally {
      if (active.timer) clearInterval(active.timer);
      clearTimeout(timeout);
      abort.abort();
      if (this.activeGeneration === active) {
        this.activeGeneration = undefined;
        this.activeAlarmAt = undefined;
      }
    }
  }
  private claim(runId: string): Claim | null {
    const run = this.run(runId);
    const message = run && this.messages.message(run.assistantId);
    if (!run || !message || run.cancelRequested) return null;
    if (message.status !== 'queued') return { context: [], claimed: false, status: message.status };
    if (this.env.GENERATION_METRICS === '1')
      this.meter = new GenerationMeter(runId, Date.now, 'claim-to-terminal', 'do-v1');
    const change = this.ctx.storage.transactionSync(() => {
      if (this.tools.model(runId) && !this.tools.claimModel(runId)) return null;
      this.query('UPDATE messages SET status = ? WHERE id = ?', 'running', message.id);
      this.query(
        'UPDATE runs SET updatedAt = ?, startedAt = ? WHERE id = ?',
        Date.now(),
        Date.now(),
        runId,
      );
      return this.messages.record([this.messages.message(message.id)!]);
    });
    if (!change) return null;
    this.broadcast(change);
    return {
      context: JSON.parse(run.context),
      ...(run.config ? { config: JSON.parse(run.config) as ProviderConfig } : {}),
      claimed: true,
      status: 'running',
      streamVersion: run.streamVersion ?? undefined,
      assistantId: run.assistantId,
    };
  }
  commit(runId: string, batches: StreamBatch[]): boolean {
    if (this.deletedAt) return false;
    const run = this.run(runId),
      message = run && this.messages.rawMessage(run.assistantId);
    if (!run || !message || message.status !== 'running') return false;
    const commit: StreamCommit = { runId, messageId: run.assistantId, batches };
    if (run.streamVersion !== STREAM_VERSION) throw new Error('Stream identity mismatch');
    validateCommit(commit);
    const first = batches[0],
      last = batches.at(-1)!;
    if (last.chunkSeq <= run.chunkSeq) {
      this.ctx.storage.transactionSync(() => {
        if (this.journal.append(commit)) throw new Error('Missing acknowledged stream commit');
      });
      return true;
    }
    if (first.chunkSeq !== run.chunkSeq + 1 || first.startOffset !== run.durableOffset)
      throw new Error('Stream sequence or offset gap');
    if (this.env.GENERATION_METRICS === '1' && !this.meter)
      this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume', 'do-v1');
    if (this.capacityBytes(MAX_DATABASE_WRITE_BYTES) > MAX_DATABASE_WRITE_BYTES)
      throw capacityError('write');
    let change: Commit;
    try {
      change = this.ctx.storage.transactionSync(() => {
        if (
          !this.journal.append(commit, {
            protocol: message.tools
              ? 'openai-chat'
              : (JSON.parse(run.config!) as ProviderConfig).provider,
          })
        )
          throw new Error('Conflicting stream sequence');
        this.query(
          'UPDATE runs SET chunkSeq = ?, durableOffset = ?, updatedAt = ? WHERE id = ?',
          last.chunkSeq,
          last.endOffset,
          Date.now(),
          runId,
        );
        const seq = this.messages.advance([message.id]);
        if (this.capacityBytes(MAX_DATABASE_WRITE_BYTES) > MAX_DATABASE_WRITE_BYTES)
          throw capacityError('write');
        return { type: 'commit', ...commit, seq };
      });
    } catch (error) {
      this.journal.forget(runId);
      throw error;
    }
    this.meter?.rawCheckpoint(last.endOffset - first.startOffset);
    this.broadcast(change);
    return true;
  }
  finish(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error: string | null = null,
    toolTurn?: ProviderToolTurn,
    failureDetails?: ProviderFailure,
    failureIssue?: ErrorIssue,
    retainPartial = false,
  ) {
    if (this.deletedAt) return;
    const run = this.run(runId);
    const message = run && this.messages.message(run.assistantId);
    if (!run || !message || message.runId !== runId || !isActive(message)) return;
    const toolModel = this.tools.model(runId),
      toolRequest = this.toolRequest(message.id),
      prior = message.generation;
    if (toolModel && status === 'completed' && !toolTurn) {
      status = 'failed';
      error = '工具模型步骤缺少完整续接资料。';
    }
    if (this.env.GENERATION_METRICS === '1' && !this.meter)
      this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume', 'do-v1');
    let roundUsage = { usage: message.streamState?.usage ?? {}, usageIsFinal: false };
    if (message.streamState) {
      const state = message.streamState;
      const parser = new ProviderStream(
        state.protocol,
        state.showReasoning,
        state,
        messageText(message),
        messageText(message, 'reasoning'),
      );
      parser.end();
      if (status === 'completed') {
        try {
          if (toolTurn?.calls.length) parser.assertEnded();
          else parser.assertComplete();
        } catch (failure) {
          status = 'failed';
          error = failure instanceof StreamParseError ? failure.message : '无法验证供应商回答。';
          retainPartial = failure instanceof StreamParseError;
          failureDetails ??= providerFailure(
            run.config ? JSON.parse(run.config) : undefined,
            'protocol',
            error,
          );
          failureIssue ??= issueOf(failure, 'GENERATION_INTERRUPTED');
        }
      }
      message.parts = messageParts(parser.content, parser.reasoning);
      message.streamState = parser.checkpoint();
      message.generation = {
        ...message.generation,
        finishReason: message.streamState.finishReason,
        rawFinishReason: message.streamState.rawFinishReason,
        finishMessage: message.streamState.finishMessage,
        diagnostics: mergeGenerationDiagnostics(
          toolModel?.round ? prior?.diagnostics : undefined,
          message.streamState.diagnostics,
        ),
        usage: message.streamState.usage,
        usageIsFinal:
          message.streamState.usageIsFinal &&
          message.streamState.done &&
          !message.streamState.failure &&
          ['stop', 'length', 'tool-calls'].includes(message.streamState.finishReason ?? ''),
      };
      roundUsage = {
        usage: toolTurn?.usage ?? message.streamState.usage,
        usageIsFinal: toolTurn?.usageIsFinal ?? Boolean(message.generation.usageIsFinal),
      };
      if (toolModel) {
        message.generation = {
          ...message.generation,
          ...addGenerationUsage(toolModel.round ? prior : undefined, {
            usage: toolTurn?.usage ?? message.streamState.usage,
            usageIsFinal: toolTurn?.usageIsFinal ?? message.generation.usageIsFinal,
          }),
        };
      }
      this.meter?.streamCounts(message.streamState);
    }
    const rootTiming = toolModel
      ? this.query<{
          providerStartedAt: number | null;
          firstTokenAt: number | null;
          claimedAt: number | null;
        }>(
          `SELECT MIN(generation_timings.providerStartedAt) AS providerStartedAt,
      MIN(generation_timings.firstTokenAt) AS firstTokenAt, MIN(runs.startedAt) AS claimedAt FROM web_tool_models
      JOIN runs ON runs.id = web_tool_models.runId LEFT JOIN generation_timings ON generation_timings.runId = runs.id WHERE rootId = ?`,
          toolModel.rootId,
        ).one()
      : undefined;
    const timing = rootTiming
      ? rootTiming.providerStartedAt === null
        ? undefined
        : { providerStartedAt: rootTiming.providerStartedAt, firstTokenAt: rootTiming.firstTokenAt }
      : this.query<{ providerStartedAt: number; firstTokenAt: number | null }>(
          'SELECT providerStartedAt, firstTokenAt FROM generation_timings WHERE runId = ?',
          runId,
        ).toArray()[0];
    if (
      status === 'completed' &&
      message.summary &&
      (!messageText(message).trim() ||
        message.streamState?.finishReason === 'length' ||
        messageText(message).length > MAX_SUMMARY_CHARACTERS)
    ) {
      status = 'failed';
      error = '摘要未完整生成或超过长度限制，未用于后续上下文。请主动重新生成。';
    }
    message.generation = {
      usage: {},
      usageIsFinal: false,
      ...message.generation,
      timing: generationTiming(
        message.createdAt,
        rootTiming?.claimedAt ?? run.startedAt,
        timing,
        this.activeGeneration?.runId === runId
          ? this.activeGeneration.endedAt
          : toolModel
            ? Date.now()
            : undefined,
      ),
    };
    const { change, finalStatus, executionStatus } = this.ctx.storage.transactionSync(() => {
      const roundTiming = this.query<{ providerStartedAt: number; firstTokenAt: number | null }>(
        'SELECT providerStartedAt,firstTokenAt FROM generation_timings WHERE runId=?',
        runId,
      ).toArray()[0];
      this.accounting.finish(`model:${runId}`, {
        status,
        ...roundUsage,
        firstTokenMs:
          roundTiming?.firstTokenAt == null
            ? undefined
            : Math.max(0, roundTiming.firstTokenAt - roundTiming.providerStartedAt),
        httpStatus: failureDetails?.status,
      });
      let finalStatus: MessageStatus = status;
      if (toolModel) {
        if (status === 'completed' && toolTurn)
          this.tools.saveTurn(runId, toolTurn, JSON.parse(run.config!));
        else
          this.tools.stop(
            toolModel.rootId,
            status === 'completed' ? 'failed' : status,
            error ?? undefined,
          );
        const state = this.tools.state(toolModel.rootId);
        finalStatus = state.status === 'active' ? 'running' : state.status;
        error = state.error ?? error;
        this.writeToolTask(
          toolModel.rootId,
          this.tools.publicTask(toolModel.rootId),
          status === 'completed' && toolTurn?.calls.length
            ? { round: toolModel.round, reasoningEnd: messageText(message, 'reasoning').length }
            : undefined,
          messageText(message, 'reasoning'),
        );
        this.query('DELETE FROM tool_model_permits WHERE runId = ?', runId);
      } else if (toolRequest)
        this.writeToolTask(toolRequest.rootId, {
          status: finalStatus,
          round: 0,
          calls: [],
        });
      if (message.streamVersion === STREAM_VERSION) this.journal.compact(message);
      if (finalStatus === 'failed') {
        message.generation!.issue =
          failureIssue ??
          (failureDetails
            ? providerIssue(failureDetails)
            : problem(
                message.summary
                  ? 'SUMMARY_FAILED'
                  : toolModel || toolRequest
                    ? 'TOOL_FAILED'
                    : 'GENERATION_INTERRUPTED',
              ));
        message.generation!.failure =
          failureDetails ??
          providerFailure(
            run.config ? (JSON.parse(run.config) as ProviderConfig) : undefined,
            toolModel || toolRequest ? 'tool' : 'protocol',
          );
      }
      const executionStatus = finalStatus;
      // Seal useful supplier output as a chat version; execution and tool accounting still fail.
      if (
        retainPartial &&
        finalStatus === 'failed' &&
        !message.summary &&
        messageText(message).trim()
      ) {
        finalStatus = 'completed';
        message.generation!.interrupted = true;
      }
      this.query(
        'INSERT INTO message_generations (messageId, payload) VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET payload = excluded.payload',
        message.id,
        JSON.stringify(message.generation),
      );
      this.query(
        'UPDATE messages SET status = ?, error = ?, streamVersion = ? WHERE id = ?',
        finalStatus,
        error,
        toolModel && finalStatus === 'running' ? null : (message.streamVersion ?? null),
        message.id,
      );
      if (finalStatus !== 'running')
        this.query(
          "UPDATE runs SET config = NULL, context = '[]' WHERE assistantId = ?",
          message.id,
        );
      const terminal = this.messages.record(
        [this.messages.message(message.id)!, ...this.resolveDependentAnswers(runId, finalStatus)],
        run.conversationId,
      );
      if (finalStatus === 'completed' && !message.summary && !message.generation?.interrupted) {
        this.completionOutbox.record({
          conversationId: run.conversationId,
          messageId: message.id,
          completedAt: Date.now(),
        });
        const first = this.query<{ id: string }>(
          "SELECT id FROM messages WHERE role='user' ORDER BY rowid LIMIT 1",
        ).toArray()[0];
        if (first)
          this.titles?.offerAutomatic(
            run.conversationId,
            messageText(this.messages.message(first.id)!),
            messageText(message),
          );
      }
      if (this.capacityBytes(MAX_DATABASE_BYTES) > MAX_DATABASE_BYTES)
        throw capacityError('terminal');
      return { change: terminal, finalStatus, executionStatus };
    });
    this.broadcast(change);
    this.ctx.waitUntil(this.accounting.deliver().finally(() => this.scheduleAlarm()));
    if (toolModel && finalStatus !== 'running') {
      if (this.activeGeneration?.runId === runId) this.activeGeneration.abort.abort();
      for (const [key, active] of this.activeTools)
        if (key.startsWith(`${toolModel.rootId}:`)) active.abort.abort();
    }
    if (finalStatus === 'completed' && !message.summary && !message.generation?.interrupted)
      this.ctx.waitUntil(this.flushCompletions().finally(() => this.scheduleAlarm()));
    this.updateSearchSoon();
    if (this.meter?.runId === runId) {
      const final = this.messages.message(message.id)!;
      const report = this.meter.report(
        executionStatus,
        this.ctx.storage.sql.databaseSize,
        messageText(final).length,
        messageText(final, 'reasoning').length,
      );
      this.meter = undefined;
      // One diagnostic row per generation, excluded from the measured application SQL window.
      try {
        this.ctx.storage.sql.exec(
          'INSERT INTO generation_measurements (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
          JSON.stringify(report),
        );
      } catch {
        console.warn('EverChat generation measurements could not be saved');
      }
      console.info('EVERCHAT_GENERATION_METRICS', JSON.stringify(report));
    }
  }
  private resolveDependentAnswers(summaryRunId: string, summaryStatus: MessageStatus): Message[] {
    const updated: Message[] = [];
    for (const dependency of this.query<Dependency>(
      'SELECT * FROM run_dependencies WHERE summaryRunId = ?',
      summaryRunId,
    ).toArray()) {
      const run = this.run(dependency.runId),
        answer = run && this.messages.rawMessage(run.assistantId);
      if (!run || !answer || !isActive(answer)) {
        this.query('DELETE FROM run_dependencies WHERE runId = ?', dependency.runId);
        continue;
      }
      let status: MessageStatus =
        run.cancelRequested || summaryStatus === 'cancelled' ? 'cancelled' : 'failed';
      let error: string | null =
        status === 'cancelled'
          ? null
          : '自动摘要失败，回答未调用模型。原始历史保留，请调整配置后主动重试。';
      if (summaryStatus === 'completed' && !run.cancelRequested) {
        try {
          const { parentId, content, settings, images, files } = JSON.parse(dependency.payload) as {
            parentId: string | null;
            content: string;
            settings: ConversationSettings;
            images: ImagePart[];
            files: DocumentPart[];
          };
          if (!run.config) throw new AppError(problem('INVALID_REQUEST'), '回答配置已丢失。');
          const prepared = summaryContext(this.messages.forHead(parentId), parentId);
          if (prepared.summary?.id !== dependency.summaryId)
            throw new AppError(problem('INVALID_REQUEST'), '自动摘要覆盖范围不匹配。');
          const built = buildContext(
            prepared.history,
            content,
            JSON.parse(run.config) as ProviderConfig,
            settings,
            summaryPrefix(prepared.summary),
            images,
            files,
          );
          assertContextFits(built.estimate);
          assertStoredContextFits(built.messages, JSON.parse(run.config) as ProviderConfig);
          // Count limits can intentionally omit raw history; token pressure after compression must be explicit.
          if (
            built.estimate.retainedMessages <
            historyCountWithinLimit(prepared.history, settings.recentMessages)
          )
            throw new ContextBudgetError(
              '自动摘要后仍无法容纳最近历史。请提高预算、手动压缩或关闭自动压缩后重试。',
            );
          this.query(
            'UPDATE runs SET context = ? WHERE id = ?',
            JSON.stringify(built.messages),
            run.id,
          );
          this.query(
            'UPDATE message_generations SET payload = ? WHERE messageId = ?',
            JSON.stringify({ usage: {}, usageIsFinal: false, context: built.estimate }),
            answer.id,
          );
          status = 'queued';
          error = null;
        } catch (failure) {
          error = failure instanceof Error ? failure.message : error;
        }
      }
      if (status !== 'queued') {
        this.query("UPDATE runs SET config = NULL, context = '[]' WHERE id = ?", run.id);
        this.query('DELETE FROM generation_timings WHERE runId = ?', run.id);
        if (answer.tools)
          this.writeToolTask(this.toolRequest(answer.id)!.rootId, { status, round: 0, calls: [] });
      }
      this.query(
        'UPDATE messages SET status = ?, error = ? WHERE id = ?',
        status,
        error,
        answer.id,
      );
      this.query('DELETE FROM run_dependencies WHERE runId = ?', run.id);
      updated.push(this.messages.rawMessage(answer.id)!);
    }
    return updated;
  }
  async cancel(runId: string) {
    if (this.deletedAt) return;
    const original = this.run(runId),
      originalMessage = original && this.messages.rawMessage(original.assistantId);
    if (originalMessage?.runId && this.toolRequest(originalMessage.id))
      runId = originalMessage.runId;
    const run = this.run(runId),
      message = run && this.messages.rawMessage(run.assistantId);
    if (!run || !message || !isActive(message)) return this.activity?.snapshot();
    const dependency = this.query<Dependency>(
      'SELECT * FROM run_dependencies WHERE runId = ? OR summaryRunId = ?',
      runId,
      runId,
    ).toArray()[0];
    const ids = dependency ? [dependency.summaryRunId, dependency.runId] : [runId];
    const stopping = this.ctx.storage.transactionSync(() => {
      for (const id of ids) this.query('UPDATE runs SET cancelRequested = 1 WHERE id = ?', id);
      return this.messages.record([]);
    });
    this.broadcast(stopping);
    const active =
      this.activeGeneration && ids.includes(this.activeGeneration.runId)
        ? this.activeGeneration
        : undefined;
    if (active) {
      active.cancelled = true;
      active.endedAt ??= Date.now();
      active.abort.abort();
      if (active.timer) clearInterval(active.timer);
    }
    // Keep the cancellation intent if flushing the tail or writing the terminal state fails.
    await this.ctx.storage.sync();
    let error: string | null = null;
    try {
      active?.buffer.flush();
    } catch (failure) {
      if (!(failure instanceof GenerationCancelled))
        error = '停止时未能保存尾部。已保留最近检查点，请主动重新生成。';
    }
    for (const id of ids)
      this.finish(
        id,
        error && active?.runId === id ? 'failed' : 'cancelled',
        error && active?.runId === id ? error : null,
      );
    await this.flushToolWorkflows();
    await this.scheduleAlarm();
    await this.ctx.storage.sync();
    return this.activity?.snapshot();
  }
  protected eraseDeletedStorage() {
    return this.ctx.storage.deleteAll();
  }
  async deleteConversation(deletedAt: number) {
    this.deletedAt = deletedAt;
    this.titles?.cancel();
    for (const tool of this.activeTools.values()) tool.abort.abort();
    const active = this.activeGeneration;
    if (active) {
      active.cancelled = true;
      active.abort.abort();
      if (active.timer) clearInterval(active.timer);
    }
    // Keep all RPCs and Alarm continuations outside the empty-database interval.
    if (!this.deletionCleaned) {
      await this.ctx.blockConcurrencyWhile(async () => {
        this.accounting.recover(new Set());
        const pending = this.accounting.pending();
        await this.eraseDeletedStorage();
        initializeStorageSchema(this.query.bind(this));
        this.ctx.storage.sql.exec(USAGE_OUTBOX_SCHEMA);
        this.accounting.restore(pending);
        this.ctx.storage.sql.exec(DELETION_SCHEMA);
        this.ctx.storage.sql.exec('INSERT INTO conversation_deletion VALUES (1, ?)', deletedAt);
        await this.ctx.storage.sync();
      });
      this.deletionCleaned = true;
    }
    await this.accounting.deliver();
    await this.scheduleAlarm();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        if (validSubscription(socket, socket.deserializeAttachment() as Attachment))
          socket.send(JSON.stringify({ type: 'deleted', deletedAt }));
        socket.close(4003, 'Conversation deleted');
      } catch {
        /* A disconnected subscriber reads the Library tombstone on reconnect. */
      }
    }
  }
  async fetch(request: Request) {
    if (this.deletedAt)
      return json({ error: '这个对话已删除。', issue: problem('CONVERSATION_DELETED') }, 410);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket required', { status: 426 });
    const expires = Number(request.headers.get('X-Session-Expires'));
    const revalidate = Number(request.headers.get('X-Session-Revalidate'));
    if (
      !Number.isFinite(expires) ||
      !Number.isFinite(revalidate) ||
      Math.min(expires, revalidate) <= Date.now() / 1000 ||
      revalidate > expires
    )
      return json(
        { error: '请重新登录。', issue: problem('AUTH_REQUIRED'), code: 'AUTH_REQUIRED' },
        401,
      );
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ expires, revalidate } satisfies Attachment);
    const params = new URL(request.url).searchParams;
    this.syncState(server, Number(params.get('after')), params.get('epoch'));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (!validSubscription(socket, socket.deserializeAttachment() as Attachment)) return;
    if (this.deletedAt) {
      socket.send(JSON.stringify({ type: 'deleted', deletedAt: this.deletedAt }));
      socket.close(4003, 'Conversation deleted');
      return;
    }
    if (typeof data === 'string' && data.length <= 1024 && data.startsWith('{')) {
      try {
        const check = JSON.parse(data) as { type?: string; seq?: number; epoch?: string };
        if (check.type === 'sync-check') {
          this.syncState(socket, check.seq ?? -1, check.epoch ?? null);
          return;
        }
      } catch {
        /* Malformed acknowledgements are rejected below. */
      }
    }
    this.subscribers.acknowledge(socket, data);
  }
  private syncState(socket: WebSocket, cursor: number, epoch: string | null) {
    const current = new ConversationState(this.query.bind(this)).current();
    const valid =
      Number.isSafeInteger(cursor) &&
      cursor >= 0 &&
      cursor <= current.seq &&
      epoch === current.epoch;
    const snapshot =
      valid && cursor < current.seq ? this.messages.changes(cursor, 900 * 1024) : undefined;
    if (!valid || (cursor < current.seq && !snapshot)) {
      this.subscribers.send(JSON.stringify({ type: 'resync' }), undefined, socket);
      return;
    }
    if (snapshot)
      this.subscribers.send(
        JSON.stringify({ type: 'state', after: cursor, snapshot }),
        undefined,
        socket,
      );
    this.subscribers.send(JSON.stringify({ type: 'ready', seq: current.seq }), undefined, socket);
    // No await between the state baseline, readiness and tail subscription.
    for (const batch of this.activeGeneration?.buffer.previewTail ?? [])
      this.preview(batch, socket);
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    // Reserved status codes describe a missing close frame; they cannot be sent back on the wire.
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, 'Reconnect to sync');
  }
}
