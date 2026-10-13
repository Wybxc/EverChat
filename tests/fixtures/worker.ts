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
  const tokens = ['**集成测试回答。**\n\n', ...Array<string>(28).fill('持续输出，'), '服务端生成完成。'];
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const content = tokens[index++];
      const delta = content ? {
        ...(index === 1 && (requestBody.thinking?.type === 'enabled' || requestBody.reasoning_effort) ? { reasoning_content: '**集成思考。**' } : {}),
        content: `${index === 1 && requestBody.model === 'test-model-2' ? '第二模型：\n\n' : ''}${content}`,
      } : {};
      const chunk = { id: 'integration', choices: [{ index: 0, delta, finish_reason: content ? null : 'stop' }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (!content) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
