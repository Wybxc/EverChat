// Test entry point: production API and runtime, mock upstream plus isolated fault-injection RPCs.
import production, { Conversation as ProductionConversation } from '../../worker/index';
import { authenticated } from '../../worker/auth';
import type { Env } from '../../worker/env';
import type { openProviderStream } from '../../worker/provider';
import type { StreamBatch } from '../../shared/types';
import { providerStreams } from './provider-streams';
import type { ProviderKind } from '../../shared/types';
export { Library } from '../../worker/index';

export class Conversation extends ProductionConversation {
  private failNextCommit = false;
  protected override async openModelStream(...args: Parameters<typeof openProviderStream>) {
    if (args[0].model.startsWith('alarm-')) {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_calls (runId TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
      const run = this.ctx.storage.sql.exec<{ id: string }>(`SELECT runs.id FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status = 'running'`).one();
      this.ctx.storage.sql.exec('INSERT INTO fixture_calls VALUES (?, 1) ON CONFLICT(runId) DO UPDATE SET calls = calls + 1', run.id);
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const match = /^\/api\/__test\/conversations\/([0-9a-f-]{36})\/(state|alarm|abort|abort-stop|history)$/.exec(url.pathname);
    if (!match) return production.fetch(request, env, ctx);
    if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
    const { runId, pairs } = await request.json() as { runId: string; pairs: number };
    const conversation = (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(match[1]);
    switch (match[2]) {
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
