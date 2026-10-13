import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ChatInput, Change, Message, MessageStatus, ProviderConfig, Snapshot, Submission, SubmitInput } from '../shared/types';
import { isActive } from '../shared/types';

type Row = Message & Record<string, SqlStorageValue>;
type Run = { id: string; conversationId: string; assistantId: string; context: string; config: string | null; chunkSeq: number; updatedAt: number } & Record<string, SqlStorageValue>;
type Failure = { error: string; status: number };

export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
      createdAt INTEGER NOT NULL, runId TEXT, parentId TEXT, revisionOf TEXT, error TEXT
    )`);
    sql.exec('CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, assistantId TEXT NOT NULL,
      context TEXT NOT NULL, chunkSeq INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL
    )`);
    sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
    const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(messages)').toArray().map((row) => row.name));
    for (const column of ['reasoning', 'providerId', 'model', 'modelName']) {
      if (!columns.has(column)) sql.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
    }
    if (!sql.exec<{ name: string }>('PRAGMA table_info(runs)').toArray().some((row) => row.name === 'config')) {
      sql.exec('ALTER TABLE runs ADD COLUMN config TEXT');
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private all(): Message[] { return this.ctx.storage.sql.exec<Row>('SELECT * FROM messages ORDER BY rowid').toArray(); }
  private message(id: string): Message | undefined { return this.ctx.storage.sql.exec<Row>('SELECT * FROM messages WHERE id = ?', id).toArray()[0]; }
  private run(id: string): Run | undefined { return this.ctx.storage.sql.exec<Run>('SELECT * FROM runs WHERE id = ?', id).toArray()[0]; }
  private seq(): number { return this.ctx.storage.sql.exec<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').one().seq; }
  snapshot(): Snapshot { return { messages: this.all(), seq: this.seq() }; }
  private record(messages: Message[]): Change {
    this.ctx.storage.sql.exec('INSERT INTO events (payload) VALUES (?)', JSON.stringify(messages));
    const seq = this.seq();
    this.ctx.storage.sql.exec('DELETE FROM events WHERE seq < ?', seq - 500);
    return { type: 'change', seq, messages };
  }
  private broadcast(change: Change) {
    // SQLite writes and events commit before the output gate releases socket sends.
    const packet = JSON.stringify(change);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { expires: number };
      if (attachment.expires <= Date.now() / 1000) { socket.close(4001, 'Session expired'); continue; }
      try { socket.send(packet); } catch { socket.close(1011, 'Reconnect to sync'); }
    }
  }
  private insert(message: Message) {
    this.ctx.storage.sql.exec('INSERT INTO messages (id, role, content, status, createdAt, runId, parentId, revisionOf, error, providerId, model, modelName, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.role, message.content, message.status, message.createdAt, message.runId, message.parentId, message.revisionOf, message.error,
      message.providerId ?? null, message.model ?? null, message.modelName ?? null, message.reasoning ?? null);
  }
  async submit(conversationId: string, input: SubmitInput, config: ProviderConfig | null): Promise<Submission | Failure> {
    // Keep the old fingerprint for requests accepted before model selection was available.
    const parts: (string | null)[] = [input.content ?? null, input.retryOf ?? null, input.revisionOf ?? null];
    if (input.selection) parts.push(input.selection.providerId, input.selection.model);
    if (input.showReasoning !== undefined || input.reasoningEffort) parts.push(input.showReasoning === true ? 'show-reasoning' : 'hide-reasoning', input.reasoningEffort ?? null);
    const fingerprint = JSON.stringify(parts);
    const duplicate = () => {
      const existing = this.ctx.storage.sql.exec<{ fingerprint: string; result: string }>('SELECT * FROM submissions WHERE id = ?', input.requestId).toArray()[0];
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
      this.ctx.storage.sql.exec('INSERT INTO runs (id, conversationId, assistantId, context, chunkSeq, updatedAt, config) VALUES (?, ?, ?, ?, 0, ?, ?)',
        runId, conversationId, assistant.id, JSON.stringify(context), Date.now(), JSON.stringify(config));
      this.ctx.storage.sql.exec('INSERT INTO submissions VALUES (?, ?, ?)', input.requestId, fingerprint, JSON.stringify(result));
      return this.record(parent ? [assistant] : [user, assistant]);
    });
    this.broadcast(change);
    return result;
  }
  async alarm() {
    // Persistent outbox retries launching only, never the paid provider call.
    for (const run of this.ctx.storage.sql.exec<Run>(`SELECT runs.* FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status IN ('queued', 'running')`).toArray()) {
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
  claim(runId: string): { context: ChatInput[]; config?: ProviderConfig; claimed: boolean; status: MessageStatus } | null {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message) return null;
    if (message.status !== 'queued') return { context: [], claimed: false, status: message.status };
    const change = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE messages SET status = ? WHERE id = ?', 'running', message.id);
      this.ctx.storage.sql.exec('UPDATE runs SET updatedAt = ? WHERE id = ?', Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
    return { context: JSON.parse(run.context), ...(run.config ? { config: JSON.parse(run.config) as ProviderConfig } : {}), claimed: true, status: 'running' };
  }
  checkpoint(runId: string, content: string, chunkSeq: number, reasoning = ''): boolean {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!run || !message || !isActive(message)) return false;
    if (chunkSeq <= run.chunkSeq) return true;
    if (content.length > 100_000) throw new Error('回答超出 100,000 字限制。');
    if (reasoning.length > 100_000) throw new Error('思考内容超出 100,000 字限制。');
    const change = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE messages SET content = ?, reasoning = ? WHERE id = ?', content, reasoning, message.id);
      this.ctx.storage.sql.exec('UPDATE runs SET chunkSeq = ?, updatedAt = ? WHERE id = ?', chunkSeq, Date.now(), runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
    return true;
  }
  finish(runId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null = null) {
    const run = this.run(runId);
    const message = run && this.message(run.assistantId);
    if (!message || !isActive(message)) return;
    const change = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, error, message.id);
      this.ctx.storage.sql.exec('UPDATE runs SET config = NULL WHERE id = ?', runId);
      return this.record([this.message(message.id)!]);
    });
    this.broadcast(change);
  }
  cancel(runId: string) { this.finish(runId, 'cancelled'); }
  closeSessions() { for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'Signed out'); }
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const expires = Number(request.headers.get('X-Session-Expires'));
    server.serializeAttachment({ expires });
    const cursor = Number(new URL(request.url).searchParams.get('after'));
    const current = this.seq();
    const first = this.ctx.storage.sql.exec<{ seq: number }>('SELECT COALESCE(MIN(seq), 0) AS seq FROM events').one().seq;
    if (!Number.isSafeInteger(cursor) || cursor < first - 1 || cursor > current) {
      server.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }));
    } else {
      for (const row of this.ctx.storage.sql.exec<{ seq: number; payload: string }>('SELECT * FROM events WHERE seq > ? ORDER BY seq', cursor)) {
        server.send(JSON.stringify({ type: 'change', seq: row.seq, messages: JSON.parse(row.payload) }));
      }
    }
    server.send(JSON.stringify({ type: 'ready', seq: current }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as { expires: number };
    if (attachment.expires <= Date.now() / 1000) socket.close(4001, 'Session expired');
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect to sync'); }
}
