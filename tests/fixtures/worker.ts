// Test entry point: keep the real Workflow, Durable Objects and API, replacing only upstream HTTP.
export { default, Conversation, Library, GenerationWorkflow } from '../../worker/index';

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
  const benchmark = /^benchmark-(text|reasoning|long)-(\d+)-(\d+)-(\d+)$/.exec(requestBody.model);
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
          content: text, ...(kind === 'reasoning' ? { reasoning_content: reasoning } : {}),
        }, finish_reason: done ? 'stop' : null }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
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
          : index === 1 && (requestBody.thinking?.type === 'enabled' || requestBody.reasoning_effort) ? { reasoning_content: '**集成思考。**' } : {}),
        content: `${index === 1 && requestBody.model === 'test-model-2' ? '第二模型：\n\n' : ''}${content}`,
      } : {};
      const chunk = { id: 'integration', choices: [{ index: 0, delta, finish_reason: content ? null : 'stop' }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (!content) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
