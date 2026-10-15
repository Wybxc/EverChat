import { DocumentError, type DocumentPart } from '../shared/documents';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ChatInput, Change, Commit, ConversationSettings, DurableChange, GenerationExecutor, Message, MessageStatus, ProviderConfig, Snapshot, StreamBatch, StreamCommit, Submission, SubmitInput } from '../shared/types';
import { branchPath, isActive } from '../shared/types';
import { commitAck, payloadBytes, STREAM_VERSION, validateCommit } from '../shared/stream-batches';
import type { GenerationMeasurements } from '../shared/generation-metrics';
import { GenerationMeter, measuredQuery } from './generation-metrics';
import { StreamJournal } from './stream-journal';
import { DELETION_SCHEMA, initializeConversation } from './conversation-schema';
import { openProviderStream } from './provider';
import { ProviderStream, StreamParseError } from '../shared/provider-stream';
import { GenerationCancelled, ProviderError } from './generation-errors';
import { GenerationBuffer } from './generation-buffer';
import { FirstTokenProbe, generationTiming } from './generation-timing';
import { json } from './http';
import { DATABASE_LIMIT_MESSAGE, HISTORY_LIMIT_MESSAGE, MAX_DATABASE_BYTES, MAX_DATABASE_START_BYTES, MAX_DATABASE_WRITE_BYTES, MAX_HISTORY_START_BYTES, MAX_MESSAGES, storageErrorMessage } from './resource-limits';
import type { SearchDocument, SearchPage } from '../shared/search';
import { searchRetryDelay } from './search-index';
import { backupMessage, type BackupMessage, type ConversationBackup } from '../shared/backup';
import { assertContextFits, buildContext, ContextBudgetError, historyCountWithinLimit } from '../shared/context-budget';
import { applyConversationSettings, DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import { messageFiles, messageImages, messageParts, messageText } from '../shared/message-content';
import { MAX_SUMMARIES, MAX_SUMMARY_CHARACTERS, prepareChatContext, summaryContext, summaryGeneration, summaryPrefix } from '../shared/summaries';

import { ImageContextError, type ImagePart } from '../shared/images';
import { createHash } from 'node:crypto';
import { assertWebToolSupport, type PublicToolTask, type WebToolCall, type WebToolName, type WebToolOutcome } from '../shared/web-tools';
import { collectProviderToolTurn, type ProviderToolTurn } from './provider-tools';
import { ToolTaskJournal, type ToolTaskState } from './tool-task-journal';
import { ToolStreamRelay } from './tool-stream-relay';
import { addGenerationUsage } from '../shared/generation';
import { toolWorkflowId, type ToolWorkflowParams } from './tool-workflow';
import type { WebToolServiceConfig } from '../shared/web-tool-service';
import { executeWebTool, terminalWebToolError, type WebToolFetch } from './web-tool-service';
import { WEB_TOOL_QUOTA_ERROR } from './web-tool-settings';

type Row = Omit<Message, 'parts' | 'waitingForSummary'> & { content: string; reasoning: string | null; generationResult: string | null; summaryResult: string | null; imageResult?: string | null; fileResult?: string | null; toolResult?: string | null; waitingForSummary?: string | null } & Record<string, SqlStorageValue>;
type Run = { id: string; conversationId: string; assistantId: string; context: string; config: string | null; chunkSeq: number; updatedAt: number;
  streamVersion: string | null; durableOffset: number;
  executor: GenerationExecutor; startedAt: number | null; cancelRequested: number } & Record<string, SqlStorageValue>;
type Attachment = { expires: number; blocked?: boolean; runId?: string; messageId?: string; sentOffset?: number; ackedOffset?: number; ackAt?: number };
type Dependency = { runId: string; summaryRunId: string; summaryId: string; payload: string } & Record<string, SqlStorageValue>;
export const SUBSCRIBER_WINDOW_BYTES = 128 * 1024;
type Failure = { error: string; status: number };
type Claim = { context: ChatInput[]; config?: ProviderConfig; claimed: boolean; status: MessageStatus; streamVersion?: string; assistantId?: string };
type ActiveGeneration = { runId: string; abort: AbortController; buffer: GenerationBuffer; privateBuffer?: GenerationBuffer; cancelled: boolean; endedAt?: number; failure?: Error; persistence?: Promise<void>; timer?: ReturnType<typeof setInterval> };
type ToolRequestRow = { messageId: string; rootId: string; enabled: string; requestHash: string; payload: string } & Record<string, SqlStorageValue>;
type WorkflowRow = { rootId: string; conversationId: string; created: number; nextAt: number; attempts: number } & Record<string, SqlStorageValue>;

export class Conversation extends DurableObject<Env> {
  private meter?: GenerationMeter;
  private readonly journal: StreamJournal;
  private readonly privateToolStreams: StreamJournal;
  private readonly tools!: ToolTaskJournal;
  private readonly activeTools = new Map<string, { abort: AbortController; result: Promise<ToolTaskState> }>();
  private activeGeneration?: ActiveGeneration;
  private deletedAt: number | null = null;
  private deletionCleaned = false;
  private searchFlush?: Promise<boolean>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeConversation(ctx.storage.sql, env.GENERATION_METRICS === '1');
    this.deletedAt = ctx.storage.sql.exec<{ deletedAt: number }>('SELECT deletedAt FROM conversation_deletion WHERE id = 1').toArray()[0]?.deletedAt ?? null;
    this.deletionCleaned = this.deletedAt !== null;
    this.journal = new StreamJournal(this.query.bind(this));
    this.privateToolStreams = new StreamJournal(this.query.bind(this), 'tool_stream_commits');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // A new instance cannot resume an old upstream socket. Recover before serving any snapshot.
    if (!this.deletedAt) {
      this.tools = new ToolTaskJournal(this.query.bind(this));
      ctx.storage.transactionSync(() => this.tools.recover());
      for (const run of this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId AND messages.runId = runs.id WHERE messages.status IN ('queued', 'running')`).toArray()) {
        const tool = this.tools.model(run.id);
        if (tool) {
          const state = this.tools.state(tool.rootId);
          if (state.status !== 'active') this.finish(run.id, state.status, state.error);
          else { const change = this.ctx.storage.transactionSync(() => this.refreshToolMessage(tool.rootId, run.conversationId)); if (change) this.broadcast(change); }
        } else if (this.rawMessage(run.assistantId)?.status === 'running') this.finishInterrupted(run);
      }
      if (this.query(`SELECT rootId FROM tool_workflows WHERE EXISTS (SELECT 1 FROM web_tool_tasks WHERE id = rootId AND status = 'active')
        OR EXISTS (SELECT 1 FROM web_tool_notifications WHERE web_tool_notifications.rootId = tool_workflows.rootId) LIMIT 1`).toArray().length) ctx.waitUntil(this.scheduleAlarm());
    }
  }
  private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(statement: string, ...bindings: SqlStorageValue[]) {
    try { return measuredQuery<T>(this.ctx.storage.sql, this.meter, statement, ...bindings); }
    catch (error) {
      const storage = storageErrorMessage(error);
      if (storage) throw new ProviderError(storage);
      throw error;
    }
  }
  generationMeasurements(): GenerationMeasurements | null {
    if (this.deletedAt) return null;
    if (this.env.GENERATION_METRICS !== '1') return null;
    const row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM generation_measurements WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.payload) as GenerationMeasurements : null;
  }
  private decorate(row: Row): Message {
    const { generationResult, summaryResult, imageResult, fileResult, toolResult, waitingForSummary, content, reasoning, ...message } = row;
    return { ...message, ...(toolResult && !message.deletedAt ? { tools: JSON.parse(toolResult) as PublicToolTask } : {}), parts: [...messageParts(content, reasoning ?? ''), ...(imageResult ? JSON.parse(imageResult) as ImagePart[] : []), ...(fileResult ? JSON.parse(fileResult) as DocumentPart[] : [])], ...(generationResult ? { generation: JSON.parse(generationResult) as Message['generation'] } : {}),
      ...(summaryResult ? { summary: JSON.parse(summaryResult) as Message['summary'] } : {}), ...(waitingForSummary ? { waitingForSummary } : {}) };
  }
  private materialize(message: Message): Message {
    if (!isActive(message) || !message.runId || message.streamVersion !== STREAM_VERSION) return message;
    const config = this.run(message.runId)?.config;
    if (!config) return message;
    const descriptor = JSON.parse(config) as ProviderConfig;
    return this.journal.materialize(message, { protocol: message.tools ? 'openai-chat' : descriptor.provider, showReasoning: descriptor.showReasoning === true });
  }
  private rows() { return this.query<Row>('SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId ORDER BY messages.rowid'); }
  private all(): Message[] { return Array.from(this.rows(), (row) => this.materialize(this.decorate(row))); }
  backup(): BackupMessage[] {
    if (this.deletedAt) return [];
    return this.all().map(backupMessage);
  }
  copySource(headId?: string): { messages: BackupMessage[]; settings: ConversationSettings } | Failure {
    if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
    let messages = Array.from(this.rows(), (row) => this.decorate(row));
    if (headId !== undefined) {
      const head = messages.find((message) => message.id === headId);
      if (!head || head.deletedAt) return { error: '找不到这条消息。', status: 404 };
      try {
        const path = branchPath(messages, headId), ids = new Set(path.map(({ id }) => id));
        messages = [...path, ...messages.filter((message) => message.summary && !ids.has(message.id) && message.summary.sourceIds.every((id) => ids.has(id)))];
      }
      catch { return { error: '消息分支关系无效，无法复制。', status: 409 }; }
    }
    // Read settings and the durable prefix together; never copy browser-only previews or start a generation.
    return { messages: messages.map((message) => backupMessage(this.materialize(message))), settings: this.settings() };
  }
  copySourceResponse(headId?: string) {
    const result = this.copySource(headId);
    return json(result, 'error' in result ? result.status : 200);
  }
  settings(): ConversationSettings {
    const row = this.query<{ payload: string }>('SELECT payload FROM conversation_settings WHERE id = 1').toArray()[0];
    return { ...DEFAULT_CONVERSATION_SETTINGS, ...(row ? JSON.parse(row.payload) as ConversationSettings : {}) };
  }
  private writeSettings(settings: ConversationSettings) {
    this.query('INSERT INTO conversation_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(settings));
  }
  async saveSettings(conversationId: string, settings: ConversationSettings): Promise<ConversationSettings | Failure> {
    if (this.deletedAt || await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)) return { error: '这个对话已删除。', status: 410 };
    const result = this.ctx.storage.transactionSync(() => {
      if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
      if (JSON.stringify(this.settings()) === JSON.stringify(settings)) {
        // An explicit choice of inherited defaults still counts as configured.
        if (!this.query('SELECT id FROM conversation_settings WHERE id = 1').toArray().length) this.writeSettings(settings);
        return null;
      }
      this.writeSettings(settings); return this.record([], undefined, settings);
    });
    if (result && 'error' in result) return result;
    if (result) this.broadcast(result);
    return settings;
  }
  restore(conversationId: string, backup: ConversationBackup): Snapshot | Failure {
    if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
    if (this.query('SELECT id FROM messages LIMIT 1').toArray().length) return { error: '目标对话已有消息。', status: 409 };
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
    const changes = this.ctx.storage.transactionSync(() => {
      for (const message of messages) {
        this.insert(message);
        if (message.deletedAt) this.query('INSERT INTO message_deletions VALUES (?, ?)', message.id, message.deletedAt);
      }
      this.writeSettings(settings);
      return batches.map((batch) => this.record(batch, conversationId, settings));
    });
    for (const change of changes) this.broadcast(change);
    this.updateSearchSoon();
    return this.snapshot();
  }
  async restoreResponse(conversationId: string, body: ReadableStream<Uint8Array>) {
    const backup = await new Response(body).json() as ConversationBackup;
    const result = this.restore(conversationId, backup);
    return json(result, 'error' in result ? result.status : 200);
  }
  private rawMessage(id: string): Message | undefined {
    const row = this.query<Row>('SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId WHERE messages.id = ?', id).toArray()[0];
    return row && this.decorate(row);
  }
  private message(id: string): Message | undefined { const message = this.rawMessage(id); return message && this.materialize(message); }
  private run(id: string): Run | undefined { return this.query<Run>('SELECT * FROM runs WHERE id = ?', id).toArray()[0]; }
  private seq(): number { return this.query<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').one().seq; }
  private snapshot(): Snapshot { return { messages: this.all(), seq: this.seq(), settings: this.settings() }; }
  snapshotResponse(): Response {
    if (this.deletedAt) return json({ error: '这个对话已删除。' }, 410);
    // RPC transfers a Response body as a stream, keeping history decoding and JSON work out of the Free Worker.
    return json(this.snapshot());
  }
  private record(messages: Message[], conversationId?: string, settings?: ConversationSettings): Change {
    const seq = this.recordPayload(JSON.stringify(settings ? { messages, settings } : messages));
    if (conversationId) for (const message of messages) if (!isActive(message) && !message.summary) {
      this.query('INSERT INTO message_search_versions VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET version = excluded.version', message.id, seq);
      this.query('INSERT INTO search_outbox VALUES (?, ?, ?) ON CONFLICT(messageId) DO UPDATE SET version = excluded.version', message.id, conversationId, seq);
    }
    return { type: 'change', seq, messages, ...(settings ? { settings } : {}) };
  }
  private searchDocument(message: Message, version: number): SearchDocument {
    return { messageId: message.id, version, role: message.role, content: messageText(message), reasoning: messageText(message, 'reasoning') };
  }
  searchDocumentPage(after: number): SearchPage {
    if (this.deletedAt) return { documents: [], after, done: true };
    const rows = this.query<Row & { ordinal: number; version: number }>(`SELECT messages.*, messages.rowid AS ordinal, COALESCE(message_search_versions.version, 0) AS version, NULL AS generationResult
      FROM messages LEFT JOIN message_search_versions ON message_search_versions.messageId = messages.id WHERE messages.rowid > ? AND NOT EXISTS (SELECT 1 FROM message_summaries WHERE message_summaries.messageId = messages.id) ORDER BY messages.rowid LIMIT 5`, after).toArray();
    const page = rows.slice(0, 4);
    return { documents: page.filter((row) => !isActive(row)).map((row) => this.searchDocument(this.decorate(row), row.version)), after: page.at(-1)?.ordinal ?? after, done: rows.length <= 4 };
  }
  private flushSearchIndex(): Promise<boolean> {
    if (this.searchFlush) return this.searchFlush;
    const flush = async () => {
      if (this.deletedAt) return true;
      const retry = this.query<{ attempts: number; nextAt: number }>('SELECT attempts, nextAt FROM search_retry WHERE id = 1').toArray()[0];
      if (retry && retry.nextAt > Date.now()) return false;
      try {
        const pending = this.query<{ messageId: string; conversationId: string; version: number }>('SELECT * FROM search_outbox ORDER BY version LIMIT 4').toArray();
        for (const item of pending) {
          const message = this.rawMessage(item.messageId);
          if (!message || this.deletedAt) continue;
          await this.env.LIBRARY.getByName('personal').applySearchDocuments(item.conversationId, [this.searchDocument(message, item.version)]);
          if (this.deletedAt) return true;
          this.query('DELETE FROM search_outbox WHERE messageId = ? AND version = ?', item.messageId, item.version);
        }
        this.query('DELETE FROM search_retry WHERE id = 1');
        return true;
      } catch {
        if (this.deletedAt) return true;
        const attempts = (retry?.attempts ?? 0) + 1;
        this.query('INSERT INTO search_retry VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET attempts = excluded.attempts, nextAt = excluded.nextAt', attempts, Date.now() + searchRetryDelay(attempts));
        console.warn('EverChat search update will retry'); return false;
      }
    };
    this.searchFlush = flush().finally(() => { this.searchFlush = undefined; });
    return this.searchFlush;
  }
  private updateSearchSoon() {
    this.ctx.waitUntil((async () => {
      const success = await this.flushSearchIndex();
      await this.ctx.storage.transaction(async () => {
        if (this.deletedAt || !this.query('SELECT messageId FROM search_outbox LIMIT 1').toArray().length) return;
        const next = success ? Date.now() + 1000 : this.query<{ nextAt: number }>('SELECT nextAt FROM search_retry WHERE id = 1').toArray()[0]?.nextAt ?? Date.now() + 30_000, alarm = await this.ctx.storage.getAlarm();
        if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
      });
    })());
  }
  private recordPayload(payload: string): number {
    this.meter?.event(payload);
    this.query('INSERT INTO events (payload) VALUES (?)', payload);
    const seq = this.seq();
    this.query('DELETE FROM events WHERE seq < ?', seq - 500);
    return seq;
  }
  private broadcast(change: DurableChange) {
    if (this.deletedAt) return;
    // Durable confirmations pass through the storage output gate; preview packets never acknowledge storage.
    this.sendPacket(JSON.stringify(change.type === 'commit' ? commitAck(change) : change));
  }
  private sendPacket(packet: string, batch?: StreamBatch, target?: WebSocket) {
    let recipients = 0;
    for (const socket of target ? [target] : this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.blocked) continue;
      if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); continue; }
      if (batch) {
        if (attachment.runId !== batch.runId || attachment.messageId !== batch.messageId) {
          Object.assign(attachment, { runId: batch.runId, messageId: batch.messageId, sentOffset: batch.startOffset, ackedOffset: batch.startOffset, ackAt: Date.now() });
        }
        if (attachment.sentOffset !== batch.startOffset || batch.endOffset - attachment.ackedOffset! > SUBSCRIBER_WINDOW_BYTES
          || (attachment.sentOffset! > attachment.ackedOffset! && Date.now() - attachment.ackAt! > 30_000)) {
          attachment.blocked = true; socket.serializeAttachment(attachment);
          socket.close(4002, 'Reconnect to sync'); continue;
        }
        attachment.sentOffset = batch.endOffset;
        socket.serializeAttachment(attachment);
      }
      try { socket.send(packet); recipients++; }
      catch { socket.close(1011, 'Reconnect to sync'); }
    }
    this.meter?.broadcast(packet, recipients);
  }
  private preview(batch: StreamBatch, target?: WebSocket) {
    if (this.deletedAt) return;
    this.sendPacket(JSON.stringify({ type: 'preview', batch }), batch, target);
  }
  private insert(message: Message) {
    this.query('INSERT INTO messages (id, role, content, status, createdAt, runId, parentId, revisionOf, error, providerId, model, modelName, reasoning, streamVersion, durableOffset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, messageText(message), message.status, message.createdAt, message.runId, message.parentId, message.revisionOf, message.error,
      message.providerId ?? null, message.model ?? null, message.modelName ?? null, messageText(message, 'reasoning'), message.streamVersion ?? null, message.durableOffset ?? 0);
    if (message.role === 'assistant' && !message.deletedAt && message.generation) this.query('INSERT INTO message_generations VALUES (?, ?)', message.id, JSON.stringify(message.generation));
    if (message.summary) this.query('INSERT INTO message_summaries VALUES (?, ?)', message.id, JSON.stringify(message.summary));
    if (messageFiles(message).length && !message.deletedAt) this.query('INSERT INTO message_files VALUES (?, ?)', message.id, JSON.stringify(messageFiles(message)));
    if (message.tools && !message.deletedAt) this.query('INSERT INTO message_web_tools VALUES (?, ?, ?, ?, ?)', message.id, crypto.randomUUID(), '[]', '', JSON.stringify(message.tools));
    if (messageImages(message).length && !message.deletedAt) this.query('INSERT INTO message_images VALUES (?, ?)', message.id, JSON.stringify(messageImages(message)));
  }
  async reviseAssistant(conversationId: string, messageId: string, requestId: string, content: string): Promise<{ messageId: string } | Failure> {
    if (this.deletedAt || await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)) return { error: '这个对话已删除。', status: 410 };
    const accepted = this.ctx.storage.transactionSync<{ messageId: string; change: Change } | { messageId: string } | Failure>(() => {
      if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
      const fingerprint = JSON.stringify(['assistant-edit', messageId, content.trim()]);
      const existing = this.query<{ fingerprint: string; result: string }>('SELECT fingerprint, result FROM submissions WHERE id = ?', requestId).toArray()[0];
      if (existing) return existing.fingerprint === fingerprint ? JSON.parse(existing.result) as { messageId: string } : { error: '此请求 ID 已用于另一条消息。', status: 409 };
      const original = this.rawMessage(messageId);
      if (!original || original.deletedAt || original.role !== 'assistant' || original.summary) return { error: '找不到要编辑的回答。', status: 404 };
      if (this.query("SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1").toArray().length) return { error: '请等待生成完成或先停止，再编辑消息。', status: 409 };
      if (!content.trim() || content.trim().length > 100_000) return { error: '请输入 1 到 100,000 字的回答。', status: 400 };
      if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_START_BYTES) return { error: DATABASE_LIMIT_MESSAGE, status: 507 };
      const messages = this.all();
      if (messages.length >= MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
      const revision: Message = { id: crypto.randomUUID(), role: 'assistant', parts: messageParts(content.trim()), status: 'completed', createdAt: Date.now(),
        runId: null, parentId: original.parentId, revisionOf: original.id, error: null,
        providerId: original.providerId, model: original.model, modelName: original.modelName };
      if (payloadBytes(JSON.stringify([...messages, revision])) > MAX_HISTORY_START_BYTES) return { error: HISTORY_LIMIT_MESSAGE, status: 507 };
      this.insert(revision);
      const result = { messageId: revision.id };
      this.query('INSERT INTO submissions VALUES (?, ?, ?)', requestId, fingerprint, JSON.stringify(result));
      return { ...result, change: this.record([this.rawMessage(revision.id)!], conversationId) };
    });
    if ('change' in accepted) { this.broadcast(accepted.change); this.updateSearchSoon(); return { messageId: accepted.messageId }; }
    return accepted;
  }
  async deleteMessage(conversationId: string, messageId: string): Promise<{ deletedAt: number } | Failure> {
    if (this.deletedAt || await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)) return { error: '这个对话已删除。', status: 410 };
    const accepted = this.ctx.storage.transactionSync<{ deletedAt: number; change: Change } | { deletedAt: number } | Failure>(() => {
      if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
      const original = this.rawMessage(messageId);
      if (!original) return { error: '找不到要删除的消息。', status: 404 };
      if (original.deletedAt) return { deletedAt: original.deletedAt };
      if (this.query("SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1").toArray().length) return { error: '请等待生成完成或先停止，再删除消息。', status: 409 };
      const deletedAt = Date.now();
      const affected = [original, ...Array.from(this.rows(), (row) => this.decorate(row)).filter((message) => !message.deletedAt && message.summary?.sourceIds.includes(messageId))];
      for (const message of affected) {
        this.query('UPDATE messages SET content = ?, reasoning = NULL, error = NULL WHERE id = ?', '', message.id);
        this.query('INSERT INTO message_deletions VALUES (?, ?)', message.id, deletedAt);
        this.query('DELETE FROM message_generations WHERE messageId = ?', message.id);
        this.query('DELETE FROM message_images WHERE messageId = ?', message.id);
        this.query('DELETE FROM message_files WHERE messageId = ?', message.id);
        const tool = this.toolRequest(message.id);
        if (tool) {
          this.query('DELETE FROM tool_model_permits WHERE runId IN (SELECT runId FROM web_tool_models WHERE rootId = ?)', tool.rootId);
          this.tools.erase(tool.rootId);
          this.query('DELETE FROM tool_workflows WHERE rootId = ?', tool.rootId);
          this.query('DELETE FROM message_web_tools WHERE messageId = ?', message.id);
        }
        if (message.runId) this.query('DELETE FROM generation_timings WHERE runId = ?', message.runId);
        // Keep request IDs so delayed retries cannot recreate deleted content, but erase their saved text.
        this.query("UPDATE submissions SET fingerprint = '' WHERE json_extract(result, '$.userId') = ? OR json_extract(result, '$.assistantId') = ? OR json_extract(result, '$.messageId') = ?", message.id, message.id, message.id);
      }
      const change = this.record(affected.map((message) => this.rawMessage(message.id)!), conversationId);
      // Force stale cursors to use the redacted snapshot instead of replaying deleted text.
      this.query('DELETE FROM events WHERE seq < ?', change.seq);
      return { deletedAt, change };
    });
    if ('change' in accepted) { this.broadcast(accepted.change); this.updateSearchSoon(); return { deletedAt: accepted.deletedAt }; }
    return accepted;
  }
  async submit(conversationId: string, input: SubmitInput, config: ProviderConfig | null): Promise<Submission | Failure> {
    if (this.deletedAt || await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)) return { error: '这个对话已删除。', status: 410 };
    const accepted = await this.ctx.storage.transaction<Submission | Failure | { result: Submission; change: Change }>(async () => {
      if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
      const fingerprint = JSON.stringify([input.content ?? null, input.retryOf ?? null, input.revisionOf ?? null, input.branchHead ?? null,
        input.selection?.providerId ?? null, input.selection?.model ?? null, input.showReasoning ?? null, input.reasoningEffort ?? null, input.settings ?? null, input.summaryThrough ?? null, input.imageIds ?? null, input.fileIds ?? null, input.tools ?? null]);
      const duplicate = () => {
        const existing = this.query<{ fingerprint: string; result: string }>('SELECT * FROM submissions WHERE id = ?', input.requestId).toArray()[0];
        if (!existing) return null;
        return existing.fingerprint === fingerprint ? JSON.parse(existing.result) as Submission : { error: '此请求 ID 已用于另一条消息。', status: 409 };
      };
      const existing = duplicate();
      if (existing) return existing;
      if (input.summaryThrough && (input.content !== undefined || input.retryOf || input.revisionOf || input.branchHead || input.settings || input.reasoningEffort || input.showReasoning !== undefined || input.imageIds !== undefined || input.fileIds !== undefined || input.tools !== undefined)) return { error: '摘要请求不能同时指定聊天内容或会话参数。', status: 400 };
      if (!config) return { error: '所选模型不可用，请配置供应商并启用模型。', status: 400 };
      if (input.tools) {
        try { assertWebToolSupport(config.modelMetadata, input.tools); }
        catch (error) { return { error: error instanceof Error ? error.message : '工具配置无效。', status: 400 }; }
        if (!this.webToolsConfigured(input.tools, config.webTools)) return { error: '尚未配置联网工具服务。', status: 400 };
        if (config.webTools) {
          const quota = await this.env.LIBRARY.getByName('personal').webToolSettings();
          if (quota.usedToday >= Math.min(quota.dailyLimit, config.webTools.dailyLimit)) return { error: WEB_TOOL_QUOTA_ERROR, status: 429 };
        }
      }
      if (this.query(`SELECT id FROM messages WHERE status IN ('queued', 'running') LIMIT 1`).toArray().length) return { error: '这个对话正在生成回答，请等待完成或先停止。', status: 409 };
      if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_START_BYTES) return { error: DATABASE_LIMIT_MESSAGE, status: 507 };
      const messages: Message[] = [];
      let historyBytes = 32;
      for (const row of this.rows()) {
        const message = this.decorate(row);
        historyBytes += payloadBytes(JSON.stringify(message)) + 1;
        if (historyBytes > MAX_HISTORY_START_BYTES) return { error: HISTORY_LIMIT_MESSAGE, status: 507 };
        messages.push(message);
      }
      if (input.summaryThrough) {
        if (messages.length >= MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
        if (messages.filter((message) => message.summary && !message.deletedAt).length >= MAX_SUMMARIES) return { error: '摘要数量已达到原型上限，请删除旧摘要或新建对话。', status: 507 };
        let prepared;
        try { prepared = summaryGeneration(messages, input.summaryThrough, config); }
        catch (error) { return { error: error instanceof Error ? error.message : '无法构建摘要输入。', status: error instanceof ContextBudgetError ? 400 : 409 }; }
        const pinned = await this.pinContextAttachments(conversationId, prepared.context);
        if (pinned) return pinned;
        const runId = crypto.randomUUID();
        const summary: Message = { id: crypto.randomUUID(), role: 'assistant', parts: [], status: 'queued', createdAt: Date.now(), runId,
          parentId: input.summaryThrough, revisionOf: null, error: null, summary: prepared.coverage,
          providerId: prepared.config.providerId, model: prepared.config.model, modelName: prepared.config.modelName || prepared.config.model,
          streamVersion: STREAM_VERSION, durableOffset: 0, generation: { usage: {}, usageIsFinal: false, context: prepared.estimate } };
        this.insert(summary);
        this.query('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
          runId, conversationId, summary.id, JSON.stringify(prepared.context), Date.now(), JSON.stringify(prepared.config), STREAM_VERSION, 'do-v1');
        const result = { runId, userId: input.summaryThrough, assistantId: summary.id };
        this.query('INSERT INTO submissions VALUES (?, ?, ?)', input.requestId, fingerprint, JSON.stringify(result));
        const change = this.record([this.rawMessage(summary.id)!], conversationId);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return { result, change };
      }
      const requestedHead = input.branchHead ? messages.find((message) => message.id === input.branchHead && message.role === 'assistant' && message.status === 'completed' && !message.deletedAt && !message.summary) : undefined;
      if (input.branchHead && !requestedHead) return { error: '找不到可继续的分支。', status: 404 };
      let parent: Message | undefined;
      let previous: Message | undefined;
      if (input.retryOf) {
        previous = messages.find((m) => m.id === input.retryOf && m.role === 'assistant' && !m.deletedAt && !m.summary);
        parent = messages.find((m) => m.id === previous?.parentId);
        if (!previous || !parent || parent.deletedAt) return { error: '找不到要重新生成的消息。', status: 404 };
      }
      const original = input.revisionOf ? messages.find((m) => m.id === input.revisionOf && m.role === 'user' && !m.deletedAt) : undefined;
      if (input.revisionOf && !original) return { error: '找不到要编辑的消息。', status: 404 };
      if (messages.length + (parent ? 1 : 2) > MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
      const content = parent ? messageText(parent) : input.content?.trim() ?? '';
      if (input.retryOf && (input.imageIds !== undefined || input.fileIds !== undefined)) return { error: '重新生成不能更换原提问的附件。', status: 400 };
      const references = parent ? { value: messageImages(parent) } : input.imageIds?.length ? await this.env.LIBRARY.getByName('personal').imageReferences(conversationId, input.imageIds) : { value: [] as ImagePart[] };
      if ('error' in references) return references;
      const images = references.value;
      const documents = parent ? { value: messageFiles(parent) } : input.fileIds?.length ? await this.env.LIBRARY.getByName('personal').documentReferences(conversationId, input.fileIds) : { value: [] as DocumentPart[] };
      if ('error' in documents) return documents;
      const files = documents.value;
      if ((!content && !images.length && !files.length) || content.length > 16_000) return { error: '请输入 1 到 16,000 字的消息。', status: 400 };
      const settings = input.settings ?? this.settings();
      let generationConfig: ProviderConfig;
      try { generationConfig = applyConversationSettings(config, settings); }
      catch (error) { return { error: error instanceof Error ? error.message : '会话参数无效。', status: 400 }; }
      const runId = crypto.randomUUID();
      const latestCompleted = [...messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt && !message.summary);
      const userParentId = original ? original.parentId : requestedHead?.id ?? latestCompleted?.id ?? null;
      let context: ChatInput[];
      let contextEstimate;
      let automatic: ReturnType<typeof summaryGeneration> | undefined;
      try {
        const built = prepareChatContext(messages, parent ? parent.parentId : userParentId, content, generationConfig, settings, images, files);
        context = built.messages; contextEstimate = built.estimate;
        if (built.automatic) {
          if (messages.length + (parent ? 2 : 3) > MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
          if (messages.filter((message) => message.summary && !message.deletedAt).length >= MAX_SUMMARIES) return { error: '摘要数量已达到原型上限，请删除旧摘要或关闭自动压缩。', status: 507 };
          const summaryConfig = settings.autoCompression.model ? await this.env.LIBRARY.getByName('personal').providerConfig(settings.autoCompression.model) : config;
          if (!summaryConfig) return { error: '自动压缩模型不可用，请启用所选模型或关闭自动压缩。', status: 400 };
          automatic = summaryGeneration(messages, built.automatic.throughId, summaryConfig);
        }
      } catch (error) { return error instanceof ContextBudgetError || error instanceof ImageContextError || error instanceof DocumentError ? { error: error.message, status: 400 }
        : { error: '消息分支关系无效，无法构建上下文。', status: 409 }; }
      const pinned = await this.pinContextAttachments(conversationId, [...context, ...(automatic?.context ?? [])]);
      if (pinned) return pinned;
      const user: Message = parent ?? {
        id: crypto.randomUUID(), role: 'user', parts: [...messageParts(content), ...images, ...files], status: 'completed', createdAt: Date.now(),
        runId: null, parentId: userParentId, revisionOf: original?.id ?? null, error: null,
      };
      const assistant: Message = {
        id: crypto.randomUUID(), role: 'assistant', parts: [], status: 'queued', createdAt: Date.now(),
        runId, parentId: user.id, revisionOf: previous?.id ?? null, error: null,
        providerId: generationConfig.providerId, model: generationConfig.model, modelName: generationConfig.modelName || generationConfig.model,
        streamVersion: STREAM_VERSION, durableOffset: 0,
        generation: { usage: {}, usageIsFinal: false, ...(!automatic ? { context: contextEstimate } : {}) },
      };
      const initializeSettings = messages.length === 0 && !this.query('SELECT id FROM conversation_settings WHERE id = 1').toArray().length;
      if (initializeSettings) this.writeSettings(settings);
      if (!parent) this.insert(user);
      const summary = automatic ? this.queueSummary(conversationId, automatic, true) : undefined;
      this.insert(assistant);
      if (input.tools) this.query('INSERT INTO message_web_tools VALUES (?, ?, ?, ?, ?)', assistant.id, input.requestId, JSON.stringify(input.tools),
        createHash('sha256').update(fingerprint).digest('hex'), JSON.stringify({ status: 'active', round: 0, calls: [] } satisfies PublicToolTask));
      this.query('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        runId, conversationId, assistant.id, JSON.stringify(automatic ? [] : context), Date.now(), JSON.stringify(generationConfig), STREAM_VERSION, 'do-v1');
      if (summary) this.query('INSERT INTO run_dependencies VALUES (?, ?, ?, ?)', runId, summary.runId!, summary.id,
        JSON.stringify({ parentId: parent ? parent.parentId : userParentId, content, settings, images, files }));
      const result = { runId, userId: user.id, assistantId: assistant.id, ...(summary ? { summaryId: summary.id } : {}) };
      this.query('INSERT INTO submissions VALUES (?, ?, ?)', input.requestId, fingerprint, JSON.stringify(result));
      const change = this.record([...(parent ? [] : [this.rawMessage(user.id)!]), ...(summary ? [this.rawMessage(summary.id)!] : []), this.rawMessage(assistant.id)!], conversationId, messages.length === 0 ? this.settings() : undefined);
      // The outbox, input/configuration and its alarm commit together before acceptance.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return { result, change };
    });
    if ('change' in accepted) { this.broadcast(accepted.change); this.updateSearchSoon(); return accepted.result; }
    return accepted;
  }
  private queueSummary(conversationId: string, prepared: ReturnType<typeof summaryGeneration>, automatic: boolean) {
    const runId = crypto.randomUUID();
    const summary: Message = { id: crypto.randomUUID(), role: 'assistant', parts: [], status: 'queued', createdAt: Date.now(), runId,
      parentId: prepared.coverage.throughId, revisionOf: null, error: null, summary: { ...prepared.coverage, ...(automatic ? { automatic: true } : {}) },
      providerId: prepared.config.providerId, model: prepared.config.model, modelName: prepared.config.modelName || prepared.config.model,
      streamVersion: STREAM_VERSION, durableOffset: 0, generation: { usage: {}, usageIsFinal: false, context: prepared.estimate } };
    this.insert(summary);
    this.query('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      runId, conversationId, summary.id, JSON.stringify(prepared.context), Date.now(), JSON.stringify(prepared.config), STREAM_VERSION, 'do-v1');
    return summary;
  }
  protected webToolsConfigured(_enabled: readonly WebToolName[], service?: WebToolServiceConfig): boolean { return Boolean(service?.apiKey); }
  protected fetchWebTool(...args: Parameters<WebToolFetch>) { return fetch(...args); }
  protected async executeWebTool(call: WebToolCall, signal: AbortSignal, service?: WebToolServiceConfig): Promise<WebToolOutcome> {
    return service ? executeWebTool(service, call, signal, (request) => this.fetchWebTool(request))
      : { id: call.id, name: call.name, status: 'failed', error: '尚未配置联网工具服务。' };
  }
  protected createWebToolWorkflow(params: ToolWorkflowParams) { return this.env.WEB_TOOLS.create({ id: toolWorkflowId(params.conversationId, params.taskId), params }); }
  protected async notifyWebToolWorkflow(taskId: string, round: number) {
    const dispatch = this.query<WorkflowRow>('SELECT * FROM tool_workflows WHERE rootId = ?', taskId).one();
    const instance = await this.env.WEB_TOOLS.get(toolWorkflowId(dispatch.conversationId, taskId));
    await instance.sendEvent({ type: `model-${round}`, payload: { taskId, round } });
  }
  private toolRequest(messageId: string) { return this.query<ToolRequestRow>('SELECT * FROM message_web_tools WHERE messageId = ?', messageId).toArray()[0]; }
  private refreshToolMessage(rootId: string, conversationId?: string): Change | null {
    const request = this.query<ToolRequestRow>('SELECT * FROM message_web_tools WHERE rootId = ?', rootId).toArray()[0];
    if (!request) return null;
    const payload = JSON.stringify(this.tools.publicTask(rootId));
    if (payload === request.payload) return null;
    this.query('UPDATE message_web_tools SET payload = ? WHERE rootId = ?', payload, rootId);
    return this.record([this.message(request.messageId)!], conversationId);
  }
  private initializeToolTasks() {
    for (const request of this.query<ToolRequestRow>(`SELECT message_web_tools.* FROM message_web_tools JOIN messages ON messages.id = messageId
      WHERE messages.status = 'queued' AND NOT EXISTS (SELECT 1 FROM web_tool_tasks WHERE web_tool_tasks.id = rootId)
      AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE run_dependencies.runId = messages.runId)`).toArray()) {
      const message = this.rawMessage(request.messageId)!, run = this.run(message.runId!)!;
      try {
        this.ctx.storage.transactionSync(() => {
          const estimate = message.generation?.context;
          if (!run.config || !estimate) throw new ProviderError('工具任务缺少已保存的配置或上下文预算。');
          this.tools.create({ id: request.rootId, runId: run.id, messageId: message.id, requestHash: request.requestHash,
            enabled: JSON.parse(request.enabled), inputBudget: estimate.inputBudget, initialTokens: estimate.totalTokens }, JSON.parse(run.config));
          this.query('INSERT INTO tool_workflows(rootId, conversationId, nextAt) VALUES (?, ?, ?)', request.rootId, run.conversationId, Date.now());
        });
      } catch (error) { this.finish(run.id, 'failed', error instanceof Error ? error.message : '无法登记工具任务。'); }
    }
  }
  private expireToolTasks() {
    this.ctx.storage.transactionSync(() => this.tools.expire());
    for (const row of this.query<{ runId: string; status: 'completed' | 'failed' | 'cancelled'; error: string | null }>(`SELECT messages.runId, web_tool_tasks.status, web_tool_tasks.error
      FROM message_web_tools JOIN web_tool_tasks ON web_tool_tasks.id = rootId JOIN messages ON messages.id = messageId
      WHERE web_tool_tasks.status != 'active' AND messages.status IN ('queued', 'running')`).toArray()) this.finish(row.runId, row.status, row.error);
  }
  private async flushToolWorkflows() {
    for (const row of this.query<WorkflowRow>(`SELECT tool_workflows.* FROM tool_workflows JOIN web_tool_tasks ON web_tool_tasks.id = rootId
      WHERE created = 0 AND status = 'active' AND nextAt <= ? LIMIT 2`, Date.now()).toArray()) {
      try {
        try { await this.createWebToolWorkflow({ conversationId: row.conversationId, taskId: row.rootId }); }
        catch {
          const instance = await this.env.WEB_TOOLS.get(toolWorkflowId(row.conversationId, row.rootId)), state = await instance.status();
          if (['errored', 'terminated', 'complete'].includes(state.status)) { await this.failToolTask(row.rootId); continue; }
        }
        if (this.deletedAt) return;
        this.query('UPDATE tool_workflows SET created = 1 WHERE rootId = ?', row.rootId);
      } catch {
        if (this.deletedAt) return;
        this.query('UPDATE tool_workflows SET attempts = attempts + 1, nextAt = ? WHERE rootId = ?', Date.now() + Math.min(30_000, 5000 * 2 ** Math.min(row.attempts, 3)), row.rootId);
      }
    }
    for (const notification of this.tools.notifications()) {
      const dispatch = this.query<WorkflowRow>('SELECT * FROM tool_workflows WHERE rootId = ?', notification.rootId).toArray()[0];
      if (!dispatch?.created) {
        if (this.tools.state(notification.rootId).status !== 'active') this.tools.acknowledge(notification.rootId, notification.round);
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
          const status = await this.env.WEB_TOOLS.get(toolWorkflowId(dispatch.conversationId, notification.rootId)).then((instance) => instance.status()).catch(() => null);
          if (status && ['complete', 'errored', 'terminated'].includes(status.status)) { this.tools.acknowledge(notification.rootId, notification.round); continue; }
        }
        this.tools.deferNotification(notification.rootId, notification.round);
      }
    }
  }
  private async scheduleAlarm(searchSuccess = false) {
    await this.ctx.storage.transaction(async () => {
      if (this.deletedAt) return;
      const times: number[] = [];
      if (this.query(`SELECT messages.id FROM messages WHERE messages.status IN ('queued', 'running')
        AND (NOT EXISTS (SELECT 1 FROM message_web_tools WHERE messageId = messages.id) OR
          EXISTS (SELECT 1 FROM tool_model_permits WHERE runId = messages.runId) OR
          (EXISTS (SELECT 1 FROM message_web_tools WHERE messageId = messages.id) AND NOT EXISTS (SELECT 1 FROM web_tool_models WHERE runId = messages.runId)
            AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE runId = messages.runId))) LIMIT 1`).toArray().length) times.push(Date.now() + 1000);
      const workflow = this.query<{ next: number | null }>(`SELECT MIN(nextAt) AS next FROM tool_workflows JOIN web_tool_tasks ON web_tool_tasks.id = rootId WHERE created = 0 AND status = 'active'`).one().next;
      if (workflow !== null) times.push(workflow);
      const tools = this.tools.nextAlarm(); if (tools !== null) times.push(tools);
      if (this.query('SELECT messageId FROM search_outbox LIMIT 1').toArray().length) times.push(searchSuccess ? Date.now() + 1000
        : this.query<{ nextAt: number }>('SELECT nextAt FROM search_retry WHERE id = 1').toArray()[0]?.nextAt ?? Date.now() + 30_000);
      if (times.length) await this.ctx.storage.setAlarm(Math.min(...times)); else await this.ctx.storage.deleteAlarm();
    });
  }
  toolTaskState(taskId: string): ToolTaskState {
    if (this.deletedAt || !this.query('SELECT id FROM web_tool_tasks WHERE id = ?', taskId).toArray().length)
      return { id: taskId, status: 'cancelled', round: 0, deadline: 0, modelRequests: 0, toolRequests: 0, runId: '', messageId: '', phase: 'cancelled', calls: [], error: '这个工具任务已删除。' };
    this.expireToolTasks(); return this.tools.state(taskId);
  }
  async scheduleToolModel(taskId: string, round: number): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId);
    if (state.status !== 'active') return state;
    if (!Number.isInteger(round) || round < 0 || round > 3 || round > state.round + 1) throw new ProviderError('工具模型轮次无效。');
    let change: Change | null;
    try { change = this.ctx.storage.transactionSync(() => {
      if (round === state.round + 1) {
        const previous = this.run(state.runId)!;
        if (!previous.config) throw new ProviderError('工具续接配置不存在。');
        const runId = crypto.randomUUID();
        this.tools.queueModel(taskId, round, runId, state.messageId, JSON.parse(previous.config));
        this.query('INSERT INTO runs(id, conversationId, assistantId, context, updatedAt, config, streamVersion) VALUES (?, ?, ?, ?, ?, ?, ?)',
          runId, previous.conversationId, state.messageId, previous.context, Date.now(), previous.config, STREAM_VERSION);
        this.query("UPDATE runs SET config = NULL, context = '[]' WHERE id = ?", previous.id);
        this.query('UPDATE messages SET runId = ?, status = ?, streamVersion = ?, durableOffset = 0 WHERE id = ?', runId, 'queued', STREAM_VERSION, state.messageId);
      }
      const current = this.tools.state(taskId);
      if (round !== current.round || current.phase !== 'queued') return null;
      const message = this.rawMessage(current.messageId)!, estimate = message.generation?.context;
      if (!estimate) throw new ProviderError('工具任务缺少上下文估算。');
      const planned = this.tools.model(current.runId)!.plannedTokens;
      this.query('UPDATE message_generations SET payload = ? WHERE messageId = ?', JSON.stringify({ ...message.generation,
        context: { ...estimate, toolTokens: planned - (estimate.totalTokens - (estimate.toolTokens ?? 0)), totalTokens: planned } }), current.messageId);
      this.query('INSERT INTO tool_model_permits VALUES (?) ON CONFLICT DO NOTHING', current.runId);
      this.query('UPDATE message_web_tools SET payload = ? WHERE rootId = ?', JSON.stringify(this.tools.publicTask(taskId)), taskId);
      return this.record([this.message(state.messageId)!]);
    }); } catch (error) {
      this.finish(state.runId, 'failed', error instanceof Error ? error.message : '无法登记下一工具模型步骤。');
      await this.scheduleAlarm(); return this.toolTaskState(taskId);
    }
    if (change) this.broadcast(change);
    await this.scheduleAlarm(); await this.ctx.storage.sync();
    return this.toolTaskState(taskId);
  }
  async runWebTool(taskId: string, callId: string): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId); if (state.status !== 'active') return state;
    const key = `${taskId}:${callId}`, existing = this.activeTools.get(key);
    if (existing) return existing.result;
    const claimed = this.ctx.storage.transactionSync(() => this.tools.claimTool(taskId, callId));
    if (!claimed) return this.tools.state(taskId);
    const abort = new AbortController(), call = this.tools.publicCalls(state.runId).find((item) => item.call.id === callId)!.call;
    const change = this.ctx.storage.transactionSync(() => this.refreshToolMessage(taskId)); if (change) this.broadcast(change);
    const result = (async () => {
      const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(15_000, state.deadline - Date.now())));
      try {
        await this.ctx.storage.sync();
        const before = this.toolTaskState(taskId); if (before.status !== 'active') return before;
        const service = (JSON.parse(this.run(state.runId)!.config!) as ProviderConfig).webTools;
        let stopError: string | undefined;
        let outcome: WebToolOutcome;
        try {
          if (service) {
            const identity = createHash('sha256').update(JSON.stringify([this.run(state.runId)!.conversationId, taskId, callId])).digest('hex');
            const budget = await this.env.LIBRARY.getByName('personal').claimWebToolRequest(identity, service.dailyLimit);
            if ('error' in budget) stopError = budget.error;
          }
          abort.signal.throwIfAborted();
          outcome = stopError ? { id: call.id, name: call.name, status: 'failed', error: stopError } : await this.executeWebTool(call, abort.signal, service);
          stopError ??= terminalWebToolError(outcome);
        }
        catch { outcome = { id: call.id, name: call.name, status: 'failed', error: '联网工具执行失败或超时。' }; }
        const current = this.toolTaskState(taskId); if (current.status !== 'active') return current;
        const update = this.ctx.storage.transactionSync(() => {
          try { this.tools.finishTool(taskId, callId, outcome); }
          catch { this.tools.finishTool(taskId, callId, { id: call.id, name: call.name, status: 'failed', error: '联网工具返回无效结果。' }); }
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
        await this.ctx.storage.sync(); return this.toolTaskState(taskId);
      } finally { clearTimeout(timer); abort.abort(); this.activeTools.delete(key); }
    })();
    this.activeTools.set(key, { abort, result }); return result;
  }
  async failToolTask(taskId: string): Promise<ToolTaskState> {
    const state = this.toolTaskState(taskId);
    if (state.status === 'active') this.finish(state.runId, 'failed', '工具编排中断。已保留保存内容，请主动重新生成。');
    await this.scheduleAlarm(); return this.toolTaskState(taskId);
  }
  async alarm() {
    if (this.deletedAt) return;
    // An RPC re-entry during a live alarm never starts a second upstream call.
    if (this.activeGeneration) return;
    const searchSuccess = await this.flushSearchIndex();
    if (this.query("SELECT messages.id FROM message_web_tools JOIN messages ON messages.id = messageId WHERE messages.status IN ('queued', 'running') LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    this.expireToolTasks(); this.initializeToolTasks();
    await this.flushToolWorkflows();
    for (const run of this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM run_dependencies WHERE run_dependencies.runId = runs.id)`).toArray()) {
      if (this.rawMessage(run.assistantId)?.runId !== run.id) continue;
      if (this.toolRequest(run.assistantId) && !this.query('SELECT runId FROM tool_model_permits WHERE runId = ?', run.id).toArray().length) continue;
      const deletion = await this.env.LIBRARY.getByName('personal').deletedAt(run.conversationId);
      if (this.deletedAt) return;
      if (deletion) { await this.deleteConversation(deletion); return; }
      const message = this.rawMessage(run.assistantId)!;
      if (message.status === 'running') this.finishInterrupted(run);
      else if (run.cancelRequested) this.finish(run.id, 'cancelled');
      else {
        const claim = this.claim(run.id);
        if (claim?.claimed) await this.runInObject(run.id, claim);
      }
    }
    await this.flushToolWorkflows();
    // Acceptance and cleanup both use transactions so cleanup cannot erase a new task's alarm.
    await this.scheduleAlarm(searchSuccess);
  }
  private finishInterrupted(run: Run) {
    this.finish(run.id, 'failed', run.cancelRequested
      ? '停止过程中后台执行被中断。已保留最近检查点，请主动重新生成。'
      : '后台执行被中断。已保留最近检查点，为避免重复计费，请主动重新生成。');
  }
  private async pinContextAttachments(conversationId: string, context: ChatInput[]): Promise<Failure | null> {
    const images = context.flatMap((message) => message.images ?? []);
    const files = context.flatMap((message) => message.files ?? []);
    if (!images.length && !files.length) return null;
    const result = await this.env.LIBRARY.getByName('personal').pinAttachments(conversationId, images, files);
    return 'error' in result ? result : null;
  }
  usesAttachment(id: string): boolean {
    if (this.deletedAt) return false;
    const needle = JSON.stringify({ attachmentId: id }).slice(1, -1);
    return Boolean(this.query('SELECT messageId FROM message_images WHERE instr(payload, ?) > 0 LIMIT 1', needle).toArray().length
      || this.query('SELECT messageId FROM message_files WHERE instr(payload, ?) > 0 LIMIT 1', needle).toArray().length
      || this.query("SELECT runs.id FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running') AND instr(runs.context, ?) > 0 LIMIT 1", needle).toArray().length);
  }
  protected openModelStream(...args: Parameters<typeof openProviderStream>) { return openProviderStream(...args); }
  private async runInObject(runId: string, claim: Claim) {
    const toolModel = this.tools.model(runId), deadline = toolModel ? this.tools.state(toolModel.rootId).deadline : Date.now() + 14 * 60_000;
    const abort = new AbortController();
    const active: ActiveGeneration = { runId, abort, cancelled: false, buffer: new GenerationBuffer(runId, claim.assistantId!,
      (batches) => {
        const saved = this.commit(runId, batches);
        if (saved) {
          const barrier = (active.persistence ?? Promise.resolve()).then(() => this.ctx.storage.sync());
          active.persistence = barrier;
          void barrier.then(() => { if (active.persistence === barrier) active.persistence = undefined; }, (error) => {
            active.failure = error instanceof Error ? error : new Error('Generation persistence failed'); abort.abort();
          });
        }
        return saved;
      }, (batch) => this.preview(batch)) };
    this.activeGeneration = active;
    if (toolModel) active.privateBuffer = new GenerationBuffer(runId, claim.assistantId!, (batches) => {
      if (this.deletedAt || !isActive(this.rawMessage(claim.assistantId!) ?? { status: 'completed' })) return false;
      this.ctx.storage.transactionSync(() => {
        this.privateToolStreams.append({ runId, messageId: claim.assistantId!, batches });
        if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_WRITE_BYTES) throw new ProviderError(DATABASE_LIMIT_MESSAGE);
      });
      const barrier = (active.persistence ?? Promise.resolve()).then(() => this.ctx.storage.sync()); active.persistence = barrier;
      void barrier.then(() => { if (active.persistence === barrier) active.persistence = undefined; }, (error) => {
        active.failure = error instanceof Error ? error : new Error('Tool persistence failed'); abort.abort();
      });
      return true;
    });
    const relay = toolModel && claim.config ? new ToolStreamRelay(claim.config, (bytes) => active.privateBuffer!.add(bytes), (bytes) => active.buffer.add(bytes)) : undefined;
    const timeout = setTimeout(() => abort.abort(), Math.max(1, Math.min(14 * 60_000, deadline - Date.now())));
    try {
      // A surviving watchdog or alarm retry will finish an orphaned running task, never replay it.
      await this.ctx.storage.setAlarm(toolModel ? deadline : Date.now() + 15 * 60_000);
      await this.ctx.storage.sync();
      if (active.cancelled || abort.signal.aborted) throw new GenerationCancelled();
      if (!claim.config) throw new ProviderError('此任务缺少已保存的供应商配置，请主动重新生成。');
      active.timer = setInterval(() => {
        if (active.cancelled || active.persistence) return;
        try { active.privateBuffer?.tick(); active.buffer.tick(); }
        catch (error) { active.failure = error instanceof Error ? error : new Error('Generation persistence failed'); abort.abort(); }
      }, 100);
      this.query('INSERT INTO generation_timings VALUES (?, ?, NULL)', runId, Date.now());
      const probe = new FirstTokenProbe(claim.config.provider, (receivedAt) => {
        if (!this.deletedAt && !active.cancelled) this.query('UPDATE generation_timings SET firstTokenAt = ? WHERE runId = ?', receivedAt, runId);
      });
      const body = await this.openModelStream(claim.config, claim.context, abort.signal, async (image) => {
        const response = await this.env.LIBRARY.getByName('personal').attachmentResponse(this.run(runId)!.conversationId, image.attachmentId, false);
        if (!response.ok) throw new ProviderError('图片不可用，回答未调用模型。');
        const data = new Uint8Array(await response.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', data);
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (sha256 !== image.sha256 || response.headers.get('Content-Type') !== image.mediaType) throw new ProviderError('图片完整性校验失败，回答未调用模型。');
        return data;
      }, async (file) => {
        const result = await this.env.LIBRARY.getByName('personal').documentText(this.run(runId)!.conversationId, file.attachmentId);
        if ('error' in result) throw new ProviderError(result.error);
        return result.value.text;
      }, toolModel ? { enabled: this.tools.enabled(toolModel.rootId), exchanges: this.tools.exchanges(toolModel.rootId, toolModel.round, claim.config) } : undefined), reader = body.getReader();
      try {
        while (true) {
          if (active.cancelled) throw new GenerationCancelled();
          if (active.failure) throw active.failure;
          if (abort.signal.aborted) throw new ProviderError('模型供应商连接已中断。');
          await active.persistence;
          const next = await reader.read();
          const receivedAt = Date.now();
          if (next.done) { active.endedAt ??= receivedAt; probe.end(receivedAt); break; }
          if (active.cancelled) throw new GenerationCancelled();
          probe.feed(next.value, receivedAt);
          if (relay) relay.add(next.value); else active.buffer.add(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      relay?.end(); active.privateBuffer?.flush(); active.buffer.flush();
      await active.persistence;
      const turn = toolModel && !active.cancelled ? await collectProviderToolTurn(claim.config, this.tools.enabled(toolModel.rootId),
        this.privateToolStreams.replay(runId, claim.assistantId!), abort.signal) : undefined;
      this.finish(runId, active.cancelled ? 'cancelled' : 'completed', null, turn);
    } catch (error) {
      active.endedAt ??= Date.now();
      let failure = active.failure ?? error;
      let tailFailed = false;
      try { active.buffer.flush(); await active.persistence; } catch (saveError) {
        if (!(saveError instanceof GenerationCancelled)) { failure = saveError; tailFailed = true; }
      }
      const cancelled = active.cancelled && !tailFailed;
      this.finish(runId, cancelled ? 'cancelled' : 'failed', cancelled ? null : toolModel && Date.now() >= deadline ? '工具任务超过 10 分钟期限，未启动后续步骤。' : failure instanceof ProviderError || failure instanceof StreamParseError
        ? failure.message : '生成中断或无法保存尾部。已保留最近检查点，请主动重新生成。');
    } finally {
      if (active.timer) clearInterval(active.timer);
      clearTimeout(timeout); abort.abort();
      if (this.activeGeneration === active) this.activeGeneration = undefined;
    }
  }
  private claim(runId: string): Claim | null {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message || run.cancelRequested) return null;
    if (message.status !== 'queued') return { context: [], claimed: false, status: message.status };
    if (this.env.GENERATION_METRICS === '1') this.meter = new GenerationMeter(runId, Date.now, 'claim-to-terminal', 'do-v1');
    const change = this.ctx.storage.transactionSync(() => {
      if (this.tools.model(runId) && !this.tools.claimModel(runId)) return null;
      this.query('UPDATE messages SET status = ? WHERE id = ?', 'running', message.id);
      this.query('UPDATE runs SET updatedAt = ?, startedAt = ? WHERE id = ?', Date.now(), Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
    if (!change) return null;
    this.broadcast(change);
    return { context: JSON.parse(run.context), ...(run.config ? { config: JSON.parse(run.config) as ProviderConfig } : {}), claimed: true, status: 'running',
      streamVersion: run.streamVersion ?? undefined, assistantId: run.assistantId };
  }
  commit(runId: string, batches: StreamBatch[]): boolean {
    if (this.deletedAt) return false;
    const run = this.run(runId), message = run && this.rawMessage(run.assistantId);
    if (!run || !message || message.status !== 'running') return false;
    const commit: StreamCommit = { runId, messageId: run.assistantId, batches };
    if (run.streamVersion !== STREAM_VERSION) throw new Error('Stream identity mismatch');
    validateCommit(commit);
    const first = batches[0], last = batches.at(-1)!;
    if (last.chunkSeq <= run.chunkSeq) {
      this.ctx.storage.transactionSync(() => {
        if (this.journal.append(commit)) throw new Error('Missing acknowledged stream commit');
      });
      return true;
    }
    if (first.chunkSeq !== run.chunkSeq + 1 || first.startOffset !== run.durableOffset) throw new Error('Stream sequence or offset gap');
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume', 'do-v1');
    if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_WRITE_BYTES) throw new ProviderError(DATABASE_LIMIT_MESSAGE);
    const change: Commit = this.ctx.storage.transactionSync(() => {
      if (!this.journal.append(commit)) throw new Error('Conflicting stream sequence');
      this.query('UPDATE runs SET chunkSeq = ?, durableOffset = ?, updatedAt = ? WHERE id = ?',
        last.chunkSeq, last.endOffset, Date.now(), runId);
      const seq = this.recordPayload(JSON.stringify(commit));
      if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_WRITE_BYTES) throw new ProviderError(DATABASE_LIMIT_MESSAGE);
      return { type: 'commit', ...commit, seq };
    });
    this.meter?.rawCheckpoint(last.endOffset - first.startOffset);
    this.broadcast(change);
    return true;
  }
  finish(runId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null = null, toolTurn?: ProviderToolTurn) {
    if (this.deletedAt) return;
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message || message.runId !== runId || !isActive(message)) return;
    const toolModel = this.tools.model(runId), toolRequest = this.toolRequest(message.id), prior = message.generation;
    if (toolModel && status === 'completed' && !toolTurn) { status = 'failed'; error = '工具模型步骤缺少完整续接资料。'; }
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume', 'do-v1');
    if (message.streamState) {
      const state = message.streamState;
      const parser = new ProviderStream(state.protocol, state.showReasoning, state, messageText(message), messageText(message, 'reasoning'));
      parser.end();
      if (status === 'completed') {
        try { if (toolTurn?.calls.length) parser.assertEnded(); else parser.assertComplete(); }
        catch (failure) { status = 'failed'; error = failure instanceof StreamParseError ? failure.message : '无法验证供应商回答。'; }
      }
      message.parts = messageParts(parser.content, parser.reasoning); message.streamState = parser.checkpoint();
      message.generation = { ...message.generation, finishReason: message.streamState.finishReason, usage: message.streamState.usage,
        usageIsFinal: message.streamState.usageIsFinal && message.streamState.done && !message.streamState.failure && ['stop', 'length'].includes(message.streamState.finishReason ?? '') };
      if (toolModel) {
        message.generation = { ...message.generation, ...addGenerationUsage(toolModel.round ? prior : undefined,
          { usage: toolTurn?.usage ?? message.streamState.usage, usageIsFinal: toolTurn?.usageIsFinal ?? message.generation.usageIsFinal }) };
      }
      this.meter?.streamCounts(message.streamState);
    }
    const rootTiming = toolModel ? this.query<{ providerStartedAt: number | null; firstTokenAt: number | null; claimedAt: number | null }>(`SELECT MIN(generation_timings.providerStartedAt) AS providerStartedAt,
      MIN(generation_timings.firstTokenAt) AS firstTokenAt, MIN(runs.startedAt) AS claimedAt FROM web_tool_models
      JOIN runs ON runs.id = web_tool_models.runId LEFT JOIN generation_timings ON generation_timings.runId = runs.id WHERE rootId = ?`, toolModel.rootId).one() : undefined;
    const timing = rootTiming ? rootTiming.providerStartedAt === null ? undefined : { providerStartedAt: rootTiming.providerStartedAt, firstTokenAt: rootTiming.firstTokenAt }
      : this.query<{ providerStartedAt: number; firstTokenAt: number | null }>('SELECT providerStartedAt, firstTokenAt FROM generation_timings WHERE runId = ?', runId).toArray()[0];
    if (status === 'completed' && message.summary && (!messageText(message).trim() || message.streamState?.finishReason === 'length' || messageText(message).length > MAX_SUMMARY_CHARACTERS)) {
      status = 'failed'; error = '摘要未完整生成或超过长度限制，未用于后续上下文。请主动重新生成。';
    }
    message.generation = { usage: {}, usageIsFinal: false, ...message.generation,
      timing: generationTiming(message.createdAt, rootTiming?.claimedAt ?? run.startedAt, timing,
        this.activeGeneration?.runId === runId ? this.activeGeneration.endedAt : toolModel ? Date.now() : undefined) };
    const { change, finalStatus } = this.ctx.storage.transactionSync(() => {
      let finalStatus: MessageStatus = status;
      if (toolModel) {
        if (status === 'completed' && toolTurn) this.tools.saveTurn(runId, toolTurn, JSON.parse(run.config!));
        else this.tools.stop(toolModel.rootId, status === 'completed' ? 'failed' : status, error ?? undefined);
        const state = this.tools.state(toolModel.rootId);
        finalStatus = state.status === 'active' ? 'running' : state.status;
        error = state.error ?? error;
        this.query('UPDATE message_web_tools SET payload = ? WHERE rootId = ?', JSON.stringify(this.tools.publicTask(toolModel.rootId)), toolModel.rootId);
        this.query('DELETE FROM tool_model_permits WHERE runId = ?', runId);
      } else if (toolRequest) this.query('UPDATE message_web_tools SET payload = ? WHERE messageId = ?', JSON.stringify({ status: finalStatus, round: 0, calls: [] }), message.id);
      if (message.streamVersion === STREAM_VERSION) this.journal.compact(message);
      if (toolRequest) this.privateToolStreams.purge(runId);
      this.query('INSERT INTO message_generations (messageId, payload) VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET payload = excluded.payload', message.id, JSON.stringify(message.generation));
      this.query('UPDATE messages SET status = ?, error = ?, streamVersion = ? WHERE id = ?', finalStatus, error,
        toolModel && finalStatus === 'running' ? null : message.streamVersion ?? null, message.id);
      if (finalStatus !== 'running') this.query("UPDATE runs SET config = NULL, context = '[]' WHERE assistantId = ?", message.id);
      const terminal = this.record([this.message(message.id)!, ...this.resolveDependentAnswers(runId, finalStatus)], run.conversationId);
      if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_BYTES) throw new ProviderError(DATABASE_LIMIT_MESSAGE);
      return { change: terminal, finalStatus };
    });
    this.broadcast(change);
    if (toolModel && finalStatus !== 'running') {
      if (this.activeGeneration?.runId === runId) this.activeGeneration.abort.abort();
      for (const [key, active] of this.activeTools) if (key.startsWith(`${toolModel.rootId}:`)) active.abort.abort();
    }
    this.updateSearchSoon();
    if (this.meter?.runId === runId) {
      const final = this.message(message.id)!;
      const report = this.meter.report(finalStatus, this.ctx.storage.sql.databaseSize, messageText(final).length, messageText(final, 'reasoning').length);
      this.meter = undefined;
      // One diagnostic row per generation, excluded from the measured application SQL window.
      try {
        this.ctx.storage.sql.exec('INSERT INTO generation_measurements (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(report));
      } catch { console.warn('EverChat generation measurements could not be saved'); }
      console.info('EVERCHAT_GENERATION_METRICS', JSON.stringify(report));
    }
  }
  private resolveDependentAnswers(summaryRunId: string, summaryStatus: MessageStatus): Message[] {
    const updated: Message[] = [];
    for (const dependency of this.query<Dependency>('SELECT * FROM run_dependencies WHERE summaryRunId = ?', summaryRunId).toArray()) {
      const run = this.run(dependency.runId), answer = run && this.rawMessage(run.assistantId);
      if (!run || !answer || !isActive(answer)) { this.query('DELETE FROM run_dependencies WHERE runId = ?', dependency.runId); continue; }
      let status: MessageStatus = run.cancelRequested || summaryStatus === 'cancelled' ? 'cancelled' : 'failed';
      let error: string | null = status === 'cancelled' ? null : '自动摘要失败，回答未调用模型。原始历史保留，请调整配置后主动重试。';
      if (summaryStatus === 'completed' && !run.cancelRequested) {
        try {
          const { parentId, content, settings, images, files } = JSON.parse(dependency.payload) as { parentId: string | null; content: string; settings: ConversationSettings; images: ImagePart[]; files: DocumentPart[] };
          if (!run.config) throw new Error('回答配置已丢失。');
          const prepared = summaryContext(this.all(), parentId, true);
          if (prepared.summary?.id !== dependency.summaryId) throw new Error('自动摘要覆盖范围不匹配。');
          const built = buildContext(prepared.history, content, JSON.parse(run.config) as ProviderConfig, settings, summaryPrefix(prepared.summary), images, files);
          assertContextFits(built.estimate);
          // Count limits can intentionally omit raw history; token pressure after compression must be explicit.
          if (built.estimate.retainedMessages < historyCountWithinLimit(prepared.history, settings.recentMessages)) throw new ContextBudgetError('自动摘要后仍无法容纳最近历史。请提高预算、手动压缩或关闭自动压缩后重试。');
          this.query('UPDATE runs SET context = ? WHERE id = ?', JSON.stringify(built.messages), run.id);
          this.query('UPDATE message_generations SET payload = ? WHERE messageId = ?', JSON.stringify({ usage: {}, usageIsFinal: false, context: built.estimate }), answer.id);
          status = 'queued'; error = null;
        } catch (failure) { error = failure instanceof Error ? failure.message : error; }
      }
      if (status !== 'queued') {
        this.query("UPDATE runs SET config = NULL, context = '[]' WHERE id = ?", run.id);
        this.query('DELETE FROM generation_timings WHERE runId = ?', run.id);
        if (answer.tools) this.query('UPDATE message_web_tools SET payload = ? WHERE messageId = ?',
          JSON.stringify({ status, round: 0, calls: [] } satisfies PublicToolTask), answer.id);
      }
      this.query('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, error, answer.id);
      this.query('DELETE FROM run_dependencies WHERE runId = ?', run.id);
      updated.push(this.rawMessage(answer.id)!);
    }
    return updated;
  }
  async cancel(runId: string) {
    if (this.deletedAt) return;
    const original = this.run(runId), originalMessage = original && this.rawMessage(original.assistantId);
    if (originalMessage?.runId && this.toolRequest(originalMessage.id)) runId = originalMessage.runId;
    const run = this.run(runId), message = run && this.rawMessage(run.assistantId);
    if (!run || !message || !isActive(message)) return;
    const dependency = this.query<Dependency>('SELECT * FROM run_dependencies WHERE runId = ? OR summaryRunId = ?', runId, runId).toArray()[0];
    const ids = dependency ? [dependency.summaryRunId, dependency.runId] : [runId];
    this.ctx.storage.transactionSync(() => { for (const id of ids) this.query('UPDATE runs SET cancelRequested = 1 WHERE id = ?', id); });
    const active = this.activeGeneration && ids.includes(this.activeGeneration.runId) ? this.activeGeneration : undefined;
    if (active) {
      active.cancelled = true; active.endedAt ??= Date.now(); active.abort.abort();
      if (active.timer) clearInterval(active.timer);
    }
    // Keep the cancellation intent if flushing the tail or writing the terminal state fails.
    await this.ctx.storage.sync();
    let error: string | null = null;
    try { active?.buffer.flush(); } catch (failure) {
      if (!(failure instanceof GenerationCancelled)) error = '停止时未能保存尾部。已保留最近检查点，请主动重新生成。';
    }
    for (const id of ids) this.finish(id, error && active?.runId === id ? 'failed' : 'cancelled', error && active?.runId === id ? error : null);
    await this.flushToolWorkflows(); await this.scheduleAlarm();
    await this.ctx.storage.sync();
  }
  closeSessions() { for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'Signed out'); }
  protected eraseDeletedStorage() { return this.ctx.storage.deleteAll(); }
  async deleteConversation(deletedAt: number) {
    this.deletedAt = deletedAt;
    for (const tool of this.activeTools.values()) tool.abort.abort();
    const active = this.activeGeneration;
    if (active) {
      active.cancelled = true; active.abort.abort();
      if (active.timer) clearInterval(active.timer);
    }
    // Keep all RPCs and Alarm continuations outside the empty-database interval.
    if (!this.deletionCleaned) {
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.eraseDeletedStorage();
        this.ctx.storage.sql.exec(DELETION_SCHEMA);
        this.ctx.storage.sql.exec('INSERT INTO conversation_deletion VALUES (1, ?)', deletedAt);
        await this.ctx.storage.sync();
      });
      this.deletionCleaned = true;
    }
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(JSON.stringify({ type: 'deleted', deletedAt })); socket.close(4003, 'Conversation deleted'); }
      catch { /* A disconnected subscriber reads the Library tombstone on reconnect. */ }
    }
  }
  async fetch(request: Request) {
    if (this.deletedAt) return json({ error: '这个对话已删除。' }, 410);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const expires = Number(request.headers.get('X-Session-Expires'));
    server.serializeAttachment({ expires } satisfies Attachment);
    const cursor = Number(new URL(request.url).searchParams.get('after'));
    const current = this.seq();
    const first = this.query<{ seq: number }>('SELECT COALESCE(MIN(seq), 0) AS seq FROM events').one().seq;
    if (!Number.isSafeInteger(cursor) || cursor < first - 1 || cursor > current) {
      server.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }));
    } else {
      for (const row of this.query<{ seq: number; payload: string }>('SELECT * FROM events WHERE seq > ? ORDER BY seq', cursor)) {
        const payload = JSON.parse(row.payload) as Message[] | StreamCommit | Pick<Change, 'messages' | 'settings'>;
        server.send(JSON.stringify(Array.isArray(payload) ? { type: 'change', seq: row.seq, messages: payload }
          : { type: 'runId' in payload ? 'commit' : 'change', seq: row.seq, ...payload }));
      }
    }
    server.send(JSON.stringify({ type: 'ready', seq: current }));
    // No await between replay, ready and this tail: the next live preview follows exactly once.
    for (const batch of this.activeGeneration?.buffer.previewTail ?? []) this.preview(batch, server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (this.deletedAt) { socket.send(JSON.stringify({ type: 'deleted', deletedAt: this.deletedAt })); socket.close(4003, 'Conversation deleted'); return; }
    const attachment = socket.deserializeAttachment() as Attachment;
    if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); return; }
    if (data === 'session-check') return;
    try {
      if (typeof data !== 'string' || data.length > 1024) throw new Error('Invalid acknowledgement');
      const ack = JSON.parse(data) as { type: string; runId: string; messageId: string; offset: number };
      if (ack.type !== 'preview-ack') throw new Error('Invalid acknowledgement');
      if (ack.runId !== attachment.runId || ack.messageId !== attachment.messageId) return;
      if (!Number.isSafeInteger(ack.offset) || ack.offset < attachment.ackedOffset! || ack.offset > attachment.sentOffset!) return;
      attachment.ackedOffset = ack.offset; attachment.ackAt = Date.now();
      socket.serializeAttachment(attachment);
    } catch { socket.close(4002, 'Reconnect to sync'); }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    // Reserved status codes describe a missing close frame; they cannot be sent back on the wire.
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect to sync'); }
}
