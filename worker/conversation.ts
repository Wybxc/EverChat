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
import { assertContextFits, buildContext, contextHistory, ContextBudgetError } from '../shared/context-budget';
import { applyConversationSettings, DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import { messageParts, messageText } from '../shared/message-content';

type Row = Omit<Message, 'parts'> & { content: string; reasoning: string | null; generationResult: string | null } & Record<string, SqlStorageValue>;
type Run = { id: string; conversationId: string; assistantId: string; context: string; config: string | null; chunkSeq: number; updatedAt: number;
  streamVersion: string | null; durableOffset: number;
  executor: GenerationExecutor; startedAt: number | null; cancelRequested: number } & Record<string, SqlStorageValue>;
type Attachment = { expires: number; blocked?: boolean; runId?: string; messageId?: string; sentOffset?: number; ackedOffset?: number; ackAt?: number };
export const SUBSCRIBER_WINDOW_BYTES = 128 * 1024;
type Failure = { error: string; status: number };
type Claim = { context: ChatInput[]; config?: ProviderConfig; claimed: boolean; status: MessageStatus; streamVersion?: string; assistantId?: string };
type ActiveGeneration = { runId: string; abort: AbortController; buffer: GenerationBuffer; cancelled: boolean; endedAt?: number; failure?: Error; persistence?: Promise<void>; timer?: ReturnType<typeof setInterval> };

export class Conversation extends DurableObject<Env> {
  private meter?: GenerationMeter;
  private readonly journal: StreamJournal;
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
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // A new instance cannot resume an old upstream socket. Recover before serving any snapshot.
    if (!this.deletedAt) {
      for (const run of this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status = 'running'`).toArray()) this.finishInterrupted(run);
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
    const { generationResult, content, reasoning, ...message } = row;
    return { ...message, parts: messageParts(content, reasoning ?? ''), ...(generationResult ? { generation: JSON.parse(generationResult) as Message['generation'] } : {}) };
  }
  private materialize(message: Message): Message {
    if (!isActive(message) || !message.runId || message.streamVersion !== STREAM_VERSION) return message;
    const config = this.run(message.runId)?.config;
    if (!config) return message;
    const descriptor = JSON.parse(config) as ProviderConfig;
    return this.journal.materialize(message, { protocol: descriptor.provider, showReasoning: descriptor.showReasoning === true });
  }
  private rows() { return this.query<Row>('SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id ORDER BY messages.rowid'); }
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
      try { messages = branchPath(messages, headId); }
      catch { return { error: '消息分支关系无效，无法复制。', status: 409 }; }
    }
    // Read settings and the durable prefix together; never copy browser-only previews or start a generation.
    return { messages: messages.map((message) => backupMessage(this.materialize(message))), settings: this.settings() };
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
    const messages: Message[] = backup.messages.map((source) => ({
      id: ids.get(source.id)!, role: source.role, parts: source.deletedAt ? [] : source.parts, deletedAt: source.deletedAt,
      status: source.status, createdAt: source.createdAt, runId: null,
      parentId: source.parentId ? ids.get(source.parentId) ?? null : null,
      revisionOf: source.revisionOf ? ids.get(source.revisionOf) ?? null : null,
      error: source.error, providerId: source.providerId, model: source.model, modelName: source.modelName,
      ...(!source.deletedAt && source.role === 'assistant' && source.generation ? { generation: source.generation } : {}),
    }));
    const change = this.ctx.storage.transactionSync(() => {
      for (const message of messages) {
        this.insert(message);
        if (message.deletedAt) this.query('INSERT INTO message_deletions VALUES (?, ?)', message.id, message.deletedAt);
      }
      this.writeSettings(backup.settings ?? DEFAULT_CONVERSATION_SETTINGS);
      return this.record(messages, conversationId, this.settings());
    });
    this.broadcast(change);
    this.updateSearchSoon();
    return this.snapshot();
  }
  private rawMessage(id: string): Message | undefined {
    const row = this.query<Row>('SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id WHERE messages.id = ?', id).toArray()[0];
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
    if (conversationId) for (const message of messages) if (!isActive(message)) {
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
      FROM messages LEFT JOIN message_search_versions ON message_search_versions.messageId = messages.id WHERE messages.rowid > ? ORDER BY messages.rowid LIMIT 5`, after).toArray();
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
  }
  async reviseAssistant(conversationId: string, messageId: string, requestId: string, content: string): Promise<{ messageId: string } | Failure> {
    if (this.deletedAt || await this.env.LIBRARY.getByName('personal').deletedAt(conversationId)) return { error: '这个对话已删除。', status: 410 };
    const accepted = this.ctx.storage.transactionSync<{ messageId: string; change: Change } | { messageId: string } | Failure>(() => {
      if (this.deletedAt) return { error: '这个对话已删除。', status: 410 };
      const fingerprint = JSON.stringify(['assistant-edit', messageId, content.trim()]);
      const existing = this.query<{ fingerprint: string; result: string }>('SELECT fingerprint, result FROM submissions WHERE id = ?', requestId).toArray()[0];
      if (existing) return existing.fingerprint === fingerprint ? JSON.parse(existing.result) as { messageId: string } : { error: '此请求 ID 已用于另一条消息。', status: 409 };
      const original = this.rawMessage(messageId);
      if (!original || original.deletedAt || original.role !== 'assistant') return { error: '找不到要编辑的回答。', status: 404 };
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
      this.query('UPDATE messages SET content = ?, reasoning = NULL, error = NULL WHERE id = ?', '', messageId);
      this.query('INSERT INTO message_deletions VALUES (?, ?)', messageId, deletedAt);
      this.query('DELETE FROM message_generations WHERE messageId = ?', original.id);
      if (original.runId) this.query('DELETE FROM generation_timings WHERE runId = ?', original.runId);
      // Keep request IDs so delayed retries cannot recreate deleted content, but erase their saved text.
      this.query("UPDATE submissions SET fingerprint = '' WHERE json_extract(result, '$.userId') = ? OR json_extract(result, '$.assistantId') = ? OR json_extract(result, '$.messageId') = ?", messageId, messageId, messageId);
      const change = this.record([this.rawMessage(messageId)!], conversationId);
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
        input.selection?.providerId ?? null, input.selection?.model ?? null, input.showReasoning ?? null, input.reasoningEffort ?? null, input.settings ?? null]);
      const duplicate = () => {
        const existing = this.query<{ fingerprint: string; result: string }>('SELECT * FROM submissions WHERE id = ?', input.requestId).toArray()[0];
        if (!existing) return null;
        return existing.fingerprint === fingerprint ? JSON.parse(existing.result) as Submission : { error: '此请求 ID 已用于另一条消息。', status: 409 };
      };
      const existing = duplicate();
      if (existing) return existing;
      if (!config) return { error: '所选模型不可用，请配置供应商并启用模型。', status: 400 };
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
      const requestedHead = input.branchHead ? messages.find((message) => message.id === input.branchHead && message.role === 'assistant' && message.status === 'completed' && !message.deletedAt) : undefined;
      if (input.branchHead && !requestedHead) return { error: '找不到可继续的分支。', status: 404 };
      let parent: Message | undefined;
      let previous: Message | undefined;
      if (input.retryOf) {
        previous = messages.find((m) => m.id === input.retryOf && m.role === 'assistant' && !m.deletedAt);
        parent = messages.find((m) => m.id === previous?.parentId);
        if (!previous || !parent || parent.deletedAt) return { error: '找不到要重新生成的消息。', status: 404 };
      }
      const original = input.revisionOf ? messages.find((m) => m.id === input.revisionOf && m.role === 'user' && !m.deletedAt) : undefined;
      if (input.revisionOf && !original) return { error: '找不到要编辑的消息。', status: 404 };
      if (messages.length + (parent ? 1 : 2) > MAX_MESSAGES) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 507 };
      const content = parent ? messageText(parent) : input.content?.trim();
      if (!content || content.length > 16_000) return { error: '请输入 1 到 16,000 字的消息。', status: 400 };
      const settings = input.settings ?? this.settings();
      let generationConfig: ProviderConfig;
      try { generationConfig = applyConversationSettings(config, settings); }
      catch (error) { return { error: error instanceof Error ? error.message : '会话参数无效。', status: 400 }; }
      const runId = crypto.randomUUID();
      const latestCompleted = [...messages].reverse().find((message) => message.status === 'completed' && !message.deletedAt);
      const userParentId = original ? original.parentId : requestedHead?.id ?? latestCompleted?.id ?? null;
      let context: ChatInput[];
      let contextEstimate;
      try {
        const built = buildContext(contextHistory(messages, parent ? parent.parentId : userParentId), content, generationConfig, settings);
        assertContextFits(built.estimate); context = built.messages; contextEstimate = built.estimate;
      } catch (error) { return error instanceof ContextBudgetError ? { error: error.message, status: 400 }
        : { error: '消息分支关系无效，无法构建上下文。', status: 409 }; }
      const user: Message = parent ?? {
        id: crypto.randomUUID(), role: 'user', parts: messageParts(content), status: 'completed', createdAt: Date.now(),
        runId: null, parentId: userParentId, revisionOf: original?.id ?? null, error: null,
      };
      const assistant: Message = {
        id: crypto.randomUUID(), role: 'assistant', parts: [], status: 'queued', createdAt: Date.now(),
        runId, parentId: user.id, revisionOf: previous?.id ?? null, error: null,
        providerId: generationConfig.providerId, model: generationConfig.model, modelName: generationConfig.modelName || generationConfig.model,
        streamVersion: STREAM_VERSION, durableOffset: 0,
        generation: { usage: {}, usageIsFinal: false, context: contextEstimate },
      };
      const result = { runId, userId: user.id, assistantId: assistant.id };
      const initializeSettings = messages.length === 0 && !this.query('SELECT id FROM conversation_settings WHERE id = 1').toArray().length;
      if (initializeSettings) this.writeSettings(settings);
      if (!parent) this.insert(user);
      this.insert(assistant);
      this.query('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion, executor) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        runId, conversationId, assistant.id, JSON.stringify(context), Date.now(), JSON.stringify(generationConfig), STREAM_VERSION, 'do-v1');
      this.query('INSERT INTO submissions VALUES (?, ?, ?)', input.requestId, fingerprint, JSON.stringify(result));
      const change = this.record(parent ? [this.rawMessage(assistant.id)!] : [this.rawMessage(user.id)!, this.rawMessage(assistant.id)!], conversationId, messages.length === 0 ? this.settings() : undefined);
      // The outbox, input/configuration and its alarm commit together before acceptance.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return { result, change };
    });
    if ('change' in accepted) { this.broadcast(accepted.change); this.updateSearchSoon(); return accepted.result; }
    return accepted;
  }
  async alarm() {
    if (this.deletedAt) return;
    // An RPC re-entry during a live alarm never starts a second upstream call.
    if (this.activeGeneration) return;
    const searchSuccess = await this.flushSearchIndex();
    for (const run of this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running')`).toArray()) {
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
    // Acceptance and cleanup both use transactions so cleanup cannot erase a new task's alarm.
    await this.ctx.storage.transaction(async () => {
      if (this.deletedAt) return;
      const pending = this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running')`).toArray();
      if (pending.length) await this.ctx.storage.setAlarm(Date.now() + 1000);
      else if (this.query('SELECT messageId FROM search_outbox LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(searchSuccess ? Date.now() + 1000 : this.query<{ nextAt: number }>('SELECT nextAt FROM search_retry WHERE id = 1').toArray()[0]?.nextAt ?? Date.now() + 30_000);
      else await this.ctx.storage.deleteAlarm();
    });
  }
  private finishInterrupted(run: Run) {
    this.finish(run.id, 'failed', run.cancelRequested
      ? '停止过程中后台执行被中断。已保留最近检查点，请主动重新生成。'
      : '后台执行被中断。已保留最近检查点，为避免重复计费，请主动重新生成。');
  }
  protected openModelStream(...args: Parameters<typeof openProviderStream>) { return openProviderStream(...args); }
  private async runInObject(runId: string, claim: Claim) {
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
    const timeout = setTimeout(() => abort.abort(), 14 * 60_000);
    try {
      // A surviving watchdog or alarm retry will finish an orphaned running task, never replay it.
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
      await this.ctx.storage.sync();
      if (active.cancelled || abort.signal.aborted) throw new GenerationCancelled();
      if (!claim.config) throw new ProviderError('此任务缺少已保存的供应商配置，请主动重新生成。');
      active.timer = setInterval(() => {
        if (active.cancelled || active.persistence) return;
        try { active.buffer.tick(); }
        catch (error) { active.failure = error instanceof Error ? error : new Error('Generation persistence failed'); abort.abort(); }
      }, 100);
      this.query('INSERT INTO generation_timings VALUES (?, ?, NULL)', runId, Date.now());
      const probe = new FirstTokenProbe(claim.config.provider, (receivedAt) => {
        if (!this.deletedAt && !active.cancelled) this.query('UPDATE generation_timings SET firstTokenAt = ? WHERE runId = ?', receivedAt, runId);
      });
      const body = await this.openModelStream(claim.config, claim.context, abort.signal), reader = body.getReader();
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
          active.buffer.add(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      active.buffer.flush();
      await active.persistence;
      this.finish(runId, active.cancelled ? 'cancelled' : 'completed', null);
    } catch (error) {
      active.endedAt ??= Date.now();
      let failure = active.failure ?? error;
      let tailFailed = false;
      try { active.buffer.flush(); await active.persistence; } catch (saveError) {
        if (!(saveError instanceof GenerationCancelled)) { failure = saveError; tailFailed = true; }
      }
      const cancelled = active.cancelled && !tailFailed;
      this.finish(runId, cancelled ? 'cancelled' : 'failed', cancelled ? null : failure instanceof ProviderError
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
      this.query('UPDATE messages SET status = ? WHERE id = ?', 'running', message.id);
      this.query('UPDATE runs SET updatedAt = ?, startedAt = ? WHERE id = ?', Date.now(), Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
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
  finish(runId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null = null) {
    if (this.deletedAt) return;
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message || !isActive(message)) return;
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume', 'do-v1');
    if (message.streamState) {
      const state = message.streamState;
      const parser = new ProviderStream(state.protocol, state.showReasoning, state, messageText(message), messageText(message, 'reasoning'));
      parser.end();
      if (status === 'completed') {
        try { parser.assertComplete(); }
        catch (failure) { status = 'failed'; error = failure instanceof StreamParseError ? failure.message : '无法验证供应商回答。'; }
      }
      message.parts = messageParts(parser.content, parser.reasoning); message.streamState = parser.checkpoint();
      message.generation = { ...message.generation, finishReason: message.streamState.finishReason, usage: message.streamState.usage,
        usageIsFinal: message.streamState.usageIsFinal && message.streamState.done && !message.streamState.failure && ['stop', 'length'].includes(message.streamState.finishReason ?? '') };
      this.meter?.streamCounts(message.streamState);
    }
    const timing = this.query<{ providerStartedAt: number; firstTokenAt: number | null }>('SELECT providerStartedAt, firstTokenAt FROM generation_timings WHERE runId = ?', runId).toArray()[0];
    message.generation = { usage: {}, usageIsFinal: false, ...message.generation,
      timing: generationTiming(message.createdAt, run.startedAt, timing, this.activeGeneration?.runId === runId ? this.activeGeneration.endedAt : undefined) };
    const change = this.ctx.storage.transactionSync(() => {
      if (message.streamVersion === STREAM_VERSION) this.journal.compact(message);
      this.query('INSERT INTO message_generations (messageId, payload) VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET payload = excluded.payload', message.id, JSON.stringify(message.generation));
      this.query('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, error, message.id);
      this.query("UPDATE runs SET config = NULL, context = '[]' WHERE id = ?", runId);
      const terminal = this.record([this.message(message.id)!], run.conversationId);
      if (this.ctx.storage.sql.databaseSize > MAX_DATABASE_BYTES) throw new ProviderError(DATABASE_LIMIT_MESSAGE);
      return terminal;
    });
    this.broadcast(change);
    this.updateSearchSoon();
    if (this.meter?.runId === runId) {
      const final = this.message(message.id)!;
      const report = this.meter.report(status, this.ctx.storage.sql.databaseSize, messageText(final).length, messageText(final, 'reasoning').length);
      this.meter = undefined;
      // One diagnostic row per generation, excluded from the measured application SQL window.
      try {
        this.ctx.storage.sql.exec('INSERT INTO generation_measurements (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(report));
      } catch { console.warn('EverChat generation measurements could not be saved'); }
      console.info('EVERCHAT_GENERATION_METRICS', JSON.stringify(report));
    }
  }
  async cancel(runId: string) {
    if (this.deletedAt) return;
    const run = this.run(runId), message = run && this.rawMessage(run.assistantId);
    if (!run || !message || !isActive(message)) return;
    this.query('UPDATE runs SET cancelRequested = 1 WHERE id = ?', runId);
    const active = this.activeGeneration?.runId === runId ? this.activeGeneration : undefined;
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
    this.finish(runId, error ? 'failed' : 'cancelled', error);
    await this.ctx.storage.sync();
  }
  closeSessions() { for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'Signed out'); }
  protected eraseDeletedStorage() { return this.ctx.storage.deleteAll(); }
  async deleteConversation(deletedAt: number) {
    this.deletedAt = deletedAt;
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
