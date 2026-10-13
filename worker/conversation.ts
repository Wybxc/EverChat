import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ChatInput, Change, DurableChange, Message, MessageStatus, ProviderConfig, Snapshot, StreamBatch, Submission, SubmitInput } from '../shared/types';
import { isActive } from '../shared/types';
import { STREAM_VERSION, validateBatch } from '../shared/stream-batches';
import type { GenerationMeasurements, StreamCounts } from '../shared/generation-metrics';
import { GenerationMeter, measuredQuery } from './generation-metrics';
import { StreamJournal } from './stream-journal';
import { initializeConversation } from './conversation-schema';

type Row = Message & Record<string, SqlStorageValue>;
type Run = { id: string; conversationId: string; assistantId: string; context: string; config: string | null; chunkSeq: number; updatedAt: number;
  streamVersion: string | null; durableOffset: number; contentLength: number; reasoningLength: number } & Record<string, SqlStorageValue>;
type Failure = { error: string; status: number };

export class Conversation extends DurableObject<Env> {
  private meter?: GenerationMeter;
  private readonly journal: StreamJournal;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeConversation(ctx.storage.sql, env.GENERATION_METRICS === '1');
    this.journal = new StreamJournal(this.query.bind(this));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(statement: string, ...bindings: SqlStorageValue[]) {
    return measuredQuery<T>(this.ctx.storage.sql, this.meter, statement, ...bindings);
  }
  generationMeasurements(): GenerationMeasurements | null {
    if (this.env.GENERATION_METRICS !== '1') return null;
    const row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM generation_measurements WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.payload) as GenerationMeasurements : null;
  }
  private materialize(message: Message): Message { return isActive(message) ? this.journal.materialize(message) : message; }
  private all(): Message[] { return this.query<Row>('SELECT * FROM messages ORDER BY rowid').toArray().map((message) => this.materialize(message)); }
  private rawMessage(id: string): Message | undefined { return this.query<Row>('SELECT * FROM messages WHERE id = ?', id).toArray()[0]; }
  private message(id: string): Message | undefined { const message = this.rawMessage(id); return message && this.materialize(message); }
  private run(id: string): Run | undefined { return this.query<Run>('SELECT * FROM runs WHERE id = ?', id).toArray()[0]; }
  private seq(): number { return this.query<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').one().seq; }
  snapshot(): Snapshot { return { messages: this.all(), seq: this.seq() }; }
  private record(messages: Message[]): Change {
    return { type: 'change', seq: this.recordPayload(JSON.stringify(messages)), messages };
  }
  private recordPayload(payload: string): number {
    this.meter?.event(payload);
    this.query('INSERT INTO events (payload) VALUES (?)', payload);
    const seq = this.seq();
    this.query('DELETE FROM events WHERE seq < ?', seq - 500);
    return seq;
  }
  private broadcast(change: DurableChange) {
    // SQLite writes and events commit before the output gate releases socket sends.
    const packet = JSON.stringify(change);
    let recipients = 0, legacyRecipients = 0, legacyPacket: string | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { expires: number; protocol?: number };
      if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); continue; }
      try {
        if (change.type === 'append' && attachment.protocol !== 2) {
          legacyPacket ??= JSON.stringify({ type: 'change', seq: change.seq, messages: [this.message(change.messageId)!] });
          socket.send(legacyPacket); legacyRecipients++;
        } else { socket.send(packet); recipients++; }
      } catch { socket.close(1011, 'Reconnect to sync'); }
    }
    this.meter?.broadcast(packet, recipients);
    if (legacyPacket) this.meter?.broadcast(legacyPacket, legacyRecipients);
  }
  private insert(message: Message) {
    this.query('INSERT INTO messages (id, role, content, status, createdAt, runId, parentId, revisionOf, error, providerId, model, modelName, reasoning, streamVersion, durableOffset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, message.content, message.status, message.createdAt, message.runId, message.parentId, message.revisionOf, message.error,
      message.providerId ?? null, message.model ?? null, message.modelName ?? null, message.reasoning ?? null, message.streamVersion ?? null, message.durableOffset ?? 0);
  }
  async submit(conversationId: string, input: SubmitInput, config: ProviderConfig | null): Promise<Submission | Failure> {
    // Keep the old fingerprint for requests accepted before model selection was available.
    const parts: (string | null)[] = [input.content ?? null, input.retryOf ?? null, input.revisionOf ?? null];
    if (input.selection) parts.push(input.selection.providerId, input.selection.model);
    if (input.showReasoning !== undefined || input.reasoningEffort) parts.push(input.showReasoning === true ? 'show-reasoning' : 'hide-reasoning', input.reasoningEffort ?? null);
    const fingerprint = JSON.stringify(parts);
    const duplicate = () => {
      const existing = this.query<{ fingerprint: string; result: string }>('SELECT * FROM submissions WHERE id = ?', input.requestId).toArray()[0];
      if (!existing) return null;
      return existing.fingerprint === fingerprint ? JSON.parse(existing.result) as Submission : { error: '此请求 ID 已用于另一条消息。', status: 409 };
    };
    const existing = duplicate();
    if (existing) return existing;
    if (!config) return { error: '所选模型不可用，请配置供应商并启用模型。', status: 400 };
    // Alarm is durable before acceptance; an interrupted request never leaves an unscheduled outbox.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    const raced = duplicate();
    if (raced) return raced;
    const messages = this.all();
    if (messages.some(isActive)) return { error: '这个对话正在生成回答，请等待完成或先停止。', status: 409 };
    if (messages.length >= 1000) return { error: '此对话已达到原型的消息上限，请新建对话。', status: 400 };
    let parent: Message | undefined;
    let previous: Message | undefined;
    if (input.retryOf) {
      previous = messages.find((m) => m.id === input.retryOf && m.role === 'assistant');
      parent = messages.find((m) => m.id === previous?.parentId);
      if (!previous || !parent) return { error: '找不到要重新生成的消息。', status: 404 };
    }
    const original = input.revisionOf ? messages.find((m) => m.id === input.revisionOf && m.role === 'user') : undefined;
    if (input.revisionOf && !original) return { error: '找不到要编辑的消息。', status: 404 };
    const content = parent?.content ?? input.content?.trim();
    if (!content || content.length > 16_000) return { error: '请输入 1 到 16,000 字的消息。', status: 400 };
    const runId = crypto.randomUUID();
    const user: Message = parent ?? {
      id: crypto.randomUUID(), role: 'user', content, status: 'completed', createdAt: Date.now(),
      runId: null, parentId: null, revisionOf: original?.id ?? null, error: null,
    };
    const assistant: Message = {
      id: crypto.randomUUID(), role: 'assistant', content: '', status: 'queued', createdAt: Date.now(),
      runId, parentId: user.id, revisionOf: previous?.id ?? null, error: null,
      providerId: config.providerId, model: config.model, modelName: config.modelName || config.model,
      streamVersion: STREAM_VERSION, durableOffset: 0,
    };
    const cutoff = parent ?? original;
    const history = cutoff ? messages.slice(0, messages.findIndex((m) => m.id === cutoff.id)) : messages;
    const superseded = new Set(messages.map((m) => m.revisionOf).filter(Boolean));
    const context: ChatInput[] = history.filter((m) => m.status === 'completed' && !superseded.has(m.id)).map(({ role, content }) => ({ role, content }));
    // Bound provider context for a personal prototype. Keep the most recent complete turns.
    while (context.length > 40 || context.reduce((n, m) => n + m.content.length, 0) > 80_000) context.shift();
    while (context[0]?.role === 'assistant') context.shift();
    context.push({ role: 'user', content });
    const result = { runId, userId: user.id, assistantId: assistant.id };
    const change = this.ctx.storage.transactionSync(() => {
      if (!parent) this.insert(user);
      this.insert(assistant);
      this.query('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config, streamVersion) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        runId, conversationId, assistant.id, JSON.stringify(context), Date.now(), JSON.stringify(config), STREAM_VERSION);
      this.query('INSERT INTO submissions VALUES (?, ?, ?)', input.requestId, fingerprint, JSON.stringify(result));
      return this.record(parent ? [this.rawMessage(assistant.id)!] : [this.rawMessage(user.id)!, this.rawMessage(assistant.id)!]);
    });
    this.broadcast(change);
    return result;
  }
  async alarm() {
    // Persistent outbox retries launching only, never the paid provider call.
    for (const run of this.query<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running')`).toArray()) {
      const message = this.message(run.assistantId)!;
      if (Date.now() - run.updatedAt > 20 * 60_000) {
        this.finish(run.id, 'failed', '后台任务已超时。已保存的内容仍可阅读，请主动重新生成。');
        continue;
      }
      if (message.status === 'queued') {
        try {
          await this.env.GENERATION.create({ id: run.id, params: { conversationId: run.conversationId, runId: run.id } });
        } catch {
          // A lost creation acknowledgement can mean the instance already exists.
          try {
            const status = await (await this.env.GENERATION.get(run.id)).status();
            if (['errored', 'terminated', 'complete'].includes(status.status)) this.finish(run.id, 'failed', '后台任务未能完成，请重新生成。');
          } catch { /* The next alarm retries the same deterministic instance ID. */ }
        }
      }
    }
    if (this.all().some(isActive)) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  claim(runId: string): { context: ChatInput[]; config?: ProviderConfig; claimed: boolean; status: MessageStatus; streamVersion?: string; assistantId?: string } | null {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message) return null;
    if (message.status !== 'queued') return { context: [], claimed: false, status: message.status };
    if (this.env.GENERATION_METRICS === '1') this.meter = new GenerationMeter(runId);
    const change = this.ctx.storage.transactionSync(() => {
      this.query('UPDATE messages SET status = ? WHERE id = ?', 'running', message.id);
      this.query('UPDATE runs SET updatedAt = ? WHERE id = ?', Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
    return { context: JSON.parse(run.context), ...(run.config ? { config: JSON.parse(run.config) as ProviderConfig } : {}), claimed: true, status: 'running',
      streamVersion: run.streamVersion ?? undefined, assistantId: run.assistantId };
  }
  append(runId: string, batch: StreamBatch, counts?: StreamCounts): boolean {
    const run = this.run(runId), message = run && this.rawMessage(run.assistantId);
    if (!run || !message || message.status !== 'running') return false;
    if (run.streamVersion !== STREAM_VERSION || batch.runId !== runId || batch.messageId !== run.assistantId) throw new Error('Stream identity mismatch');
    validateBatch(batch);
    if (batch.chunkSeq <= run.chunkSeq) {
      this.ctx.storage.transactionSync(() => {
        if (this.journal.append(batch)) throw new Error('Missing acknowledged stream batch');
      });
      return true;
    }
    if (batch.chunkSeq !== run.chunkSeq + 1 || batch.startOffset !== run.durableOffset) throw new Error('Stream sequence or offset gap');
    const contentLength = run.contentLength + batch.content.length, reasoningLength = run.reasoningLength + batch.reasoning.length;
    if (contentLength > 100_000 || reasoningLength > 100_000) throw new Error('Stream exceeds message limits');
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume');
    const change = this.ctx.storage.transactionSync(() => {
      if (!this.journal.append(batch)) throw new Error('Conflicting stream sequence');
      this.query('UPDATE runs SET chunkSeq = ?, durableOffset = ?, contentLength = ?, reasoningLength = ?, updatedAt = ? WHERE id = ?',
        batch.chunkSeq, batch.endOffset, contentLength, reasoningLength, Date.now(), runId);
      return { type: 'append' as const, ...batch, seq: this.recordPayload(JSON.stringify(batch)) };
    });
    this.meter?.checkpoint(batch.content.length, batch.reasoning.length, counts);
    this.broadcast(change);
    return true;
  }
  checkpoint(runId: string, content: string, chunkSeq: number, reasoning = '', counts?: StreamCounts): boolean {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message || !isActive(message)) return false;
    if (run.streamVersion === STREAM_VERSION) throw new Error('Incremental runs require append');
    if (chunkSeq <= run.chunkSeq) return true;
    if (content.length > 100_000) throw new Error('回答超出 100,000 字限制。');
    if (reasoning.length > 100_000) throw new Error('思考内容超出 100,000 字限制。');
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume');
    this.meter?.checkpoint(content.length, reasoning.length, counts);
    const change = this.ctx.storage.transactionSync(() => {
      this.query('UPDATE messages SET content = ?, reasoning = ? WHERE id = ?', content, reasoning, message.id);
      this.query('UPDATE runs SET chunkSeq = ?, updatedAt = ? WHERE id = ?', chunkSeq, Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
    return true;
  }
  finish(runId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null = null) {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!message || !isActive(message)) return;
    if (this.env.GENERATION_METRICS === '1' && !this.meter) this.meter = new GenerationMeter(runId, Date.now, 'since-last-resume');
    const change = this.ctx.storage.transactionSync(() => {
      if (message.streamVersion === STREAM_VERSION) this.journal.compact(message);
      this.query('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, error, message.id);
      this.query('UPDATE runs SET config = NULL WHERE id = ?', runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
    if (this.meter?.runId === runId) {
      const final = this.message(message.id)!;
      const report = this.meter.report(status, this.ctx.storage.sql.databaseSize, final.content.length, final.reasoning?.length ?? 0);
      this.meter = undefined;
      // One diagnostic row per generation, excluded from the measured application SQL window.
      try {
        this.ctx.storage.sql.exec('INSERT INTO generation_measurements (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(report));
      } catch { console.warn('EverChat generation measurements could not be saved'); }
      console.info('EVERCHAT_GENERATION_METRICS', JSON.stringify(report));
    }
  }
  cancel(runId: string) { this.finish(runId, 'cancelled'); }
  closeSessions() { for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'Signed out'); }
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const expires = Number(request.headers.get('X-Session-Expires'));
    const url = new URL(request.url), protocol = url.searchParams.get('protocol') === '2' ? 2 : 1;
    server.serializeAttachment({ expires, protocol });
    const cursor = Number(new URL(request.url).searchParams.get('after'));
    const current = this.seq();
    const first = this.query<{ seq: number }>('SELECT COALESCE(MIN(seq), 0) AS seq FROM events').one().seq;
    if (protocol === 1 || !Number.isSafeInteger(cursor) || cursor < first - 1 || cursor > current) {
      server.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }));
    } else {
      for (const row of this.query<{ seq: number; payload: string }>('SELECT * FROM events WHERE seq > ? ORDER BY seq', cursor)) {
        const payload = JSON.parse(row.payload) as Message[] | StreamBatch;
        server.send(JSON.stringify(Array.isArray(payload) ? { type: 'change', seq: row.seq, messages: payload } : { type: 'append', seq: row.seq, ...payload }));
      }
    }
    server.send(JSON.stringify({ type: 'ready', seq: current }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as { expires: number };
    if (attachment.expires <= Date.now() / 1000) socket.close(4001, 'Session expired');
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    // Reserved status codes describe a missing close frame; they cannot be sent back on the wire.
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect to sync'); }
}
