// Test entry point: production API and runtime, mock upstream plus isolated fault-injection RPCs.
import production, { Conversation as ProductionConversation, Library as ProductionLibrary } from '../../worker/index';
import { authenticated } from '../../worker/auth';
import type { Env } from '../../worker/env';
import type { openProviderStream } from '../../worker/provider';
import type { StreamBatch } from '../../shared/types';
import { providerStreams } from './provider-streams';
import type { ProviderKind } from '../../shared/types';
import { MAX_CONVERSATIONS, MAX_DATABASE_BYTES } from '../../worker/resource-limits';

export class Library extends ProductionLibrary {
  fixtureDeletionHistory(count: number) {
    if (!Number.isInteger(count) || count < 0 || count > 600) throw new Error('Invalid deletion fixture count');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_deletion_ids (id TEXT PRIMARY KEY)');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM conversation_deletions WHERE id IN (SELECT id FROM fixture_deletion_ids)');
      this.ctx.storage.sql.exec('DELETE FROM fixture_deletion_ids');
      for (let index = 0; index < count; index++) {
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec('INSERT INTO fixture_deletion_ids VALUES (?)', id);
        this.ctx.storage.sql.exec('INSERT INTO conversation_deletions VALUES (?, ?, 1)', id, Date.now());
      }
    });
  }
  fixtureSupplierCall(id: string) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_supplier_calls (id TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO fixture_supplier_calls VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET calls = calls + 1', id);
  }
  fixtureSupplierCalls(id: string) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_supplier_calls (id TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    return this.ctx.storage.sql.exec<{ calls: number }>('SELECT calls FROM fixture_supplier_calls WHERE id = ?', id).toArray()[0]?.calls ?? 0;
  }
  fixtureCapacity(seed: boolean) {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM conversations WHERE title = '__capacity_fixture__'");
      if (seed) {
        const count = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations').one().count;
        for (let index = count; index < MAX_CONVERSATIONS - 1; index++) this.create(crypto.randomUUID(), '__capacity_fixture__');
      }
    });
    return { count: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations').one().count };
  }
}

export class Conversation extends ProductionConversation {
  private failNextCommit = false;
  private failDelete = false;
  private resetDelete = false;
  fixtureDeleteFailure(reset: boolean) { if (reset) this.resetDelete = true; else this.failDelete = true; }
  override async deleteConversation(deletedAt: number) {
    if (this.failDelete) { this.failDelete = false; throw new Error('Injected deletion failure'); }
    return super.deleteConversation(deletedAt);
  }
  protected override async eraseDeletedStorage() {
    await super.eraseDeletedStorage();
    if (this.resetDelete) this.ctx.abort('Intentional reset after deleting storage');
  }
  async fixtureDeletionState() {
    const marker = this.ctx.storage.sql.exec<{ deletedAt: number }>('SELECT deletedAt FROM conversation_deletion WHERE id = 1').toArray()[0]?.deletedAt ?? null;
    return { ...this.fixtureResources(), deletedAt: marker, alarmAt: await this.ctx.storage.getAlarm(),
      events: this.fixtureCount('events'), submissions: this.fixtureCount('submissions') };
  }
  override snapshotResponse() {
    const faults = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'fixture_storage_fault'").toArray();
    if (faults.length) throw new Error('SQLITE_FULL private fixture diagnostic');
    return super.snapshotResponse();
  }
  fixtureStorageError() { this.ctx.storage.sql.exec('CREATE TABLE fixture_storage_fault (id INTEGER)'); }
  fixtureFillDatabase(target: number) {
    if (!Number.isInteger(target) || target < 0 || target > MAX_DATABASE_BYTES - 512 * 1024) throw new Error('Invalid storage fixture size');
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS fixture_padding (payload BLOB NOT NULL)');
    while (sql.databaseSize < target) sql.exec('INSERT INTO fixture_padding VALUES (zeroblob(?))', Math.min(256 * 1024, target - sql.databaseSize));
    return this.fixtureResources();
  }
  fixtureResources() {
    const sql = this.ctx.storage.sql;
    const hasCalls = sql.exec("SELECT name FROM sqlite_master WHERE name = 'fixture_calls'").toArray().length;
    return { databaseBytes: sql.databaseSize, messages: this.fixtureCount('messages'), runs: this.fixtureCount('runs'),
      retainedContexts: this.fixtureCount('runs', "WHERE context != '[]'"), journalRows: this.fixtureCount('stream_commits'),
      calls: hasCalls ? sql.exec<{ calls: number }>('SELECT COALESCE(SUM(calls), 0) AS calls FROM fixture_calls').one().calls : 0 };
  }
  private fixtureCount(table: string, where = '') {
    if (!this.ctx.storage.sql.exec('SELECT name FROM sqlite_master WHERE name = ?', table).toArray().length) return 0;
    return this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} ${where}`).one().count;
  }
  protected override async openModelStream(...args: Parameters<typeof openProviderStream>) {
    if (args[0].model.startsWith('alarm-')) {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_calls (runId TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
      const run = this.ctx.storage.sql.exec<{ id: string; conversationId: string }>(`SELECT runs.id, runs.conversationId FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status = 'running'`).one();
      this.ctx.storage.sql.exec('INSERT INTO fixture_calls VALUES (?, 1) ON CONFLICT(runId) DO UPDATE SET calls = calls + 1', run.id);
      await (this.env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal').fixtureSupplierCall(run.conversationId);
      if (args[0].model === 'alarm-cancel-tail-failure') {
        let step = 0;
        return new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            if (step++ === 0) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '停止前的内容'.repeat(200) } }] })}\n\n`));
              return;
            }
            // Let the first complete event become durable, then fail cancel's tail write.
            await new Promise((resolve) => setTimeout(resolve, 1700));
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '尚未保存的尾部' } }] })}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 150));
            this.failNextCommit = true;
            await this.cancel(run.id);
            try { controller.close(); } catch { /* The reader may already have been cancelled. */ }
          },
        });
      }
    }
    return super.openModelStream(...args);
  }
  override commit(runId: string, batches: StreamBatch[]) {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected storage failure'); }
    return super.commit(runId, batches);
  }
  async fixtureState(runId: string) {
    const run = this.ctx.storage.sql.exec<{ executor: string; cancelRequested: number; startedAt: number | null }>('SELECT executor, cancelRequested, startedAt FROM runs WHERE id = ?', runId).one();
    const hasCalls = this.ctx.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'fixture_calls'`).toArray().length;
    const calls = hasCalls ? this.ctx.storage.sql.exec<{ calls: number }>('SELECT calls FROM fixture_calls WHERE runId = ?', runId).toArray()[0]?.calls ?? 0 : 0;
    return { ...run, calls };
  }
  fixtureReenterAlarm() { return this.alarm(); }
  async fixtureAbort(runId: string, stopping: boolean) {
    if (stopping) this.ctx.storage.sql.exec('UPDATE runs SET cancelRequested = 1 WHERE id = ?', runId);
    await this.ctx.storage.sync();
    this.ctx.abort('Intentional test reset', { retryAlarm: true });
  }
  fixtureHistory(pairs: number) {
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 16) throw new Error('Invalid history fixture size');
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count) throw new Error('Seed only an empty test conversation');
    const content = '正文🙂'.repeat(22500), reasoning = '思考🙂'.repeat(22500), input = '历史🙂'.repeat(4000);
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < pairs; index++) {
        const userId = crypto.randomUUID(), runId = crypto.randomUUID();
        sql.exec('INSERT INTO messages (id, role, content, status, createdAt, runId) VALUES (?, ?, ?, ?, ?, ?)',
          userId, 'user', input, 'completed', index * 2, null);
        sql.exec('INSERT INTO messages (id, role, content, reasoning, status, createdAt, runId, parentId, model, modelName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), 'assistant', content, reasoning, 'completed', index * 2 + 1, runId, userId, 'history-fixture', 'History fixture');
      }
      // Simulate compacted old events, so a cursor of zero must use the full snapshot path.
      sql.exec("INSERT INTO events (seq, payload) VALUES (501, '[]')");
    });
    return { messages: pairs * 2, contentCharacters: pairs * (input.length + content.length), reasoningCharacters: pairs * reasoning.length,
      databaseBytes: sql.databaseSize };
  }
  fixtureSearchHistory() {
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count) throw new Error('Seed only an empty test conversation');
    const user = crypto.randomUUID(), assistant = crypto.randomUUID(), last = crypto.randomUUID();
    const filler = Array.from({ length: 80 }, (_, index) => `阅读段落 ${index + 1}，用于验证长消息中的搜索定位。`).join('\n\n');
    this.ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO messages (id, role, content, status, createdAt) VALUES (?, ?, ?, ?, ?)', user, 'user', '用户 TARGET 与 [a+b] 😀', 'completed', 1);
      sql.exec('INSERT INTO messages (id, role, content, reasoning, status, createdAt, modelName) VALUES (?, ?, ?, ?, ?, ?, ?)', assistant, 'assistant',
        `## 章节\n\n跨越 **格式** 搜索。\n\nTARGET 起点\n\n${filler}\n\n\`\`\`js\nconst TARGET = 1;\n\`\`\`\n\n尾部 TARGET 与 [a+b]`,
        `隐藏目标在开头\n\n${filler}\n\n末尾思考终点`, 'completed', 2, 'TARGET 模型名');
      sql.exec('INSERT INTO messages (id, role, content, status, createdAt) VALUES (?, ?, ?, ?, ?)', last, 'assistant', '第二个回答 target，Unicode 😀 中文。', 'completed', 3);
    });
    return { user, assistant, last };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/api/__test/library/capacity') {
      if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      const { seed } = await request.json() as { seed: boolean };
      return Response.json(await (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal').fixtureCapacity(seed));
    }
    if (url.pathname === '/api/__test/library/deletion-history') {
      if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      const { count } = await request.json() as { count: number };
      await (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal').fixtureDeletionHistory(count);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/__test/library/deletion') {
      if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      const { id, begin } = await request.json() as { id: string; begin?: boolean };
      const library = (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal');
      if (begin) return Response.json(await library.beginDelete(id));
      return Response.json({ deletedAt: await library.deletedAt(id), calls: await library.fixtureSupplierCalls(id) });
    }
    const match = /^\/api\/__test\/conversations\/([0-9a-f-]{36})\/(state|alarm|abort|abort-stop|history|search-history|fill|resources|storage-error|delete-failure|delete-reset|deletion-state|late-submit)$/.exec(url.pathname);
    if (!match) return production.fetch(request, env, ctx);
    if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
    const { runId, pairs, target } = await request.json() as { runId: string; pairs: number; target: number };
    const conversation = (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(match[1]);
    switch (match[2]) {
      case 'search-history': return Response.json(await conversation.fixtureSearchHistory());
      case 'late-submit': {
        const result = await conversation.submit(match[1], { requestId: runId, content: '迟到的 RPC' }, await env.LIBRARY.getByName('personal').providerConfig());
        return Response.json(result, { status: 'error' in result ? result.status : 202 });
      }
      case 'delete-failure': await conversation.fixtureDeleteFailure(false); break;
      case 'delete-reset': await conversation.fixtureDeleteFailure(true); break;
      case 'deletion-state': return Response.json(await conversation.fixtureDeletionState());
      case 'fill': return Response.json(await conversation.fixtureFillDatabase(target));
      case 'resources': return Response.json(await conversation.fixtureResources());
      case 'storage-error': await conversation.fixtureStorageError(); break;
      case 'history': return Response.json(await conversation.fixtureHistory(pairs));
      case 'state': return Response.json(await conversation.fixtureState(runId));
      case 'alarm': await conversation.fixtureReenterAlarm(); break;
      case 'abort':
      case 'abort-stop':
        try { await conversation.fixtureAbort(runId, match[2] === 'abort-stop'); }
        catch { return Response.json({ reset: true }, { status: 503 }); }
        break;
    }
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<Env>;

const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== 'provider.test') return upstreamFetch(input, init);
  if (request.headers.get('Authorization') !== 'Bearer integration-test-key' && request.headers.get('x-api-key') !== 'integration-test-key' && request.headers.get('x-goog-api-key') !== 'integration-test-key') {
    return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }
  if (url.pathname === '/v1/models') {
    return Response.json({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] });
  }
  if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname) && !url.pathname.includes(':streamGenerateContent')) return new Response('Not found', { status: 404 });
  const requestBody = await request.clone().json() as { model: string; thinking?: { type: string }; reasoning_effort?: string; reasoning?: { effort?: string } };
  const encoder = new TextEncoder();
  const rawKind = requestBody.model?.startsWith('raw-') ? requestBody.model.slice(4) as ProviderKind
    : url.pathname.includes('/models/raw-gemini:') ? 'gemini' : undefined;
  if (rawKind && providerStreams[rawKind]) {
    const { partial, finish } = providerStreams[rawKind];
    const bytes = encoder.encode(partial + finish);
    // Split a supplementary Unicode character and hold the incomplete frame through a commit.
    const marker = encoder.encode(partial).indexOf(0xf0) + 2;
    let step = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const current = step++;
        if (current === 0) controller.enqueue(bytes.slice(0, marker));
        else if (current === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1900));
          controller.enqueue(bytes.slice(marker, encoder.encode(partial).length));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1900));
          controller.enqueue(bytes.slice(encoder.encode(partial).length)); controller.close();
        }
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }

  if (requestBody.model === 'alarm-stall' || requestBody.model === 'alarm-stall-cr') {
    let stop: (() => void) | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stop = () => controller.error(new Error('Upstream aborted'));
        if (request.signal.aborted) { stop(); return; }
        request.signal.addEventListener('abort', stop, { once: true });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'idle', choices: [{ index: 0,
          delta: { content: '等待上游的正文', reasoning_content: '等待上游的思考' }, finish_reason: null }] })}${requestBody.model === 'alarm-stall-cr' ? '\r\r' : '\n\n'}`));
      },
      cancel() { if (stop) request.signal.removeEventListener('abort', stop); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const benchmark = /^benchmark-(text|reasoning|long|error)-(\d+)-(\d+)-(\d+)$/.exec(requestBody.model);
  if (benchmark) {
    const [, kind, count, delay, size] = benchmark;
    const chunks = Math.min(Number(count), 1000);
    const interval = Math.min(Number(delay), 500);
    const characters = Math.min(Number(size), Math.floor(90_000 / Math.max(1, chunks)));
    let index = 0;
    const text = '正文🙂'.repeat(Math.ceil(characters / 4)).slice(0, characters);
    const reasoning = '思考🙂'.repeat(Math.ceil(characters / 4)).slice(0, characters);
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        const done = index++ >= chunks;
        const chunk = { id: 'benchmark', choices: [{ index: 0, delta: done ? {} : {
          content: text, ...(kind === 'reasoning' || kind === 'error' ? { reasoning_content: reasoning } : {}),
        }, finish_reason: done && kind !== 'error' ? 'stop' : null }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (done) {
          if (kind !== 'error') controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (url.pathname === '/v1/responses') {
    const events = [
      ...(requestBody.reasoning?.effort !== 'none' ? [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'thought', summary: [], content: [] } },
        { type: 'response.content_part.added', item_id: 'thought', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } },
        { type: 'response.reasoning_text.delta', item_id: 'thought', output_index: 0, content_index: 0, delta: '**集成' },
        { type: 'response.reasoning_text.delta', item_id: 'thought', output_index: 0, content_index: 0, delta: '思考。**' },
        { type: 'response.reasoning_text.done', item_id: 'thought', output_index: 0, content_index: 0, text: '**集成思考。**' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'thought', summary: [], content: [{ type: 'reasoning_text', text: '**集成思考。**' }] } },
      ] : []),
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'answer' } },
      ...['**集成测试回答。**\n\n', ...Array<string>(8).fill('持续输出，'), '服务端生成完成。'].map((delta) => ({ type: 'response.output_text.delta', item_id: 'answer', output_index: 1, content_index: 0, delta })),
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'answer' } },
      { type: 'response.completed', response: { incomplete_details: null } },
    ];
    let eventIndex = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[eventIndex++])}\n\n`));
        if (eventIndex === events.length) controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const scrollTest = requestBody.model === 'scroll-test';
  const tokens = scrollTest
    ? Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}：持续生成的内容。\n\n`)
    : ['**集成测试回答。**\n\n', ...Array<string>(28).fill('持续输出，'), '服务端生成完成。'];
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const content = tokens[index++];
      const delta = content ? {
        ...(scrollTest ? { reasoning_content: `思考 ${index}：持续生成的思考内容。\n\n` }
          : index === 1 && (requestBody.model.startsWith('alarm-') || requestBody.thinking?.type === 'enabled' || requestBody.reasoning_effort) ? { reasoning_content: '**集成思考。**' } : {}),
        content: `${index === 1 && requestBody.model === 'test-model-2' ? '第二模型：\n\n' : ''}${content}`,
      } : {};
      const chunk = { id: 'integration', choices: [{ index: 0, delta, finish_reason: content ? null : 'stop' }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (!content) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
