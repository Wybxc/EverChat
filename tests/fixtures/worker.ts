// Test entry point: production API and runtime, mock upstream plus isolated fault-injection RPCs.
import production, { Conversation as ProductionConversation } from '../../worker/index';
import { authenticated } from '../../worker/auth';
import type { Env } from '../../worker/env';
import type { generate } from '../../worker/provider';
import type { StreamBatch } from '../../shared/types';
import type { StreamCounts } from '../../shared/generation-metrics';
export { Library } from '../../worker/index';

export class Conversation extends ProductionConversation {
  private failNextCommit = false;
  protected override async generateModel(...args: Parameters<typeof generate>) {
    if (args[0].model.startsWith('alarm-')) {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_calls (runId TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
      const run = this.ctx.storage.sql.exec<{ id: string }>(`SELECT runs.id FROM runs JOIN messages ON messages.id = runs.assistantId WHERE messages.status = 'running'`).one();
      this.ctx.storage.sql.exec('INSERT INTO fixture_calls VALUES (?, 1) ON CONFLICT(runId) DO UPDATE SET calls = calls + 1', run.id);
      if (args[0].model === 'alarm-cancel-tail-failure') {
        // No I/O between receiving this tail and cancellation; the write fails inside cancel().
        await args[2]('停止前的内容'.repeat(2000)); await args[2]('尚未保存的尾部');
        this.failNextCommit = true;
        await this.cancel(run.id);
        return;
      }
    }
    return super.generateModel(...args);
  }
  override commit(runId: string, batches: StreamBatch[], counts?: StreamCounts) {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected storage failure'); }
    return super.commit(runId, batches, counts);
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

}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const match = /^\/api\/__test\/conversations\/([0-9a-f-]{36})\/(state|alarm|abort|abort-stop)$/.exec(url.pathname);
    if (!match) return production.fetch(request, env, ctx);
    if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
    const { runId } = await request.json() as { runId: string };
    const conversation = (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(match[1]);
    switch (match[2]) {
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
  if (request.headers.get('Authorization') !== 'Bearer integration-test-key') {
    return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }
  if (url.pathname === '/v1/models') {
    return Response.json({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] });
  }
  if (!['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  const requestBody = await request.clone().json() as { model: string; thinking?: { type: string }; reasoning_effort?: string; reasoning?: { effort?: string } };
  const encoder = new TextEncoder();
  if (requestBody.model === 'alarm-stall') {
    let stop: (() => void) | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stop = () => controller.error(new Error('Upstream aborted'));
        if (request.signal.aborted) { stop(); return; }
        request.signal.addEventListener('abort', stop, { once: true });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'idle', choices: [{ index: 0,
          delta: { content: '等待上游的正文', reasoning_content: '等待上游的思考' }, finish_reason: null }] })}\n\n`));
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
