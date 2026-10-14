import type { ProviderKind } from '../../shared/types';

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
export const toolQuery = 'Cloudflare 文档🙂';
export function toolStream(protocol: ProviderKind, options: { name?: string; input?: string; count?: number; duplicate?: boolean; redacted?: boolean; signature?: string[] } = {}) {
  const name = options.name ?? 'web_search', input = options.input ?? JSON.stringify({ query: toolQuery });
  const calls = Array.from({ length: options.count ?? 1 }, (_, index) => ({ id: `call_${options.duplicate ? 0 : index}`, name, input }));
  if (protocol === 'openai-chat') return [
    { choices: [{ index: 0, delta: { reasoning_content: '检索资料🙂' } }] },
    ...calls.flatMap((call, index) => [
      { choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name, arguments: input.slice(0, 6) } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: input.slice(6) } }] } }] },
    ]),
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ].map(frame).join('') + 'data: [DONE]\n\n';
  if (protocol === 'openai-responses') return [
    { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'tool-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: null } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', output_index: 0, summary_index: 0, delta: '检索资料🙂' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'encrypted-fixture', summary: [{ type: 'summary_text', text: '检索资料🙂' }] } },
    ...calls.flatMap((call, index) => [
      { type: 'response.output_item.added', output_index: index + 1, item: { type: 'function_call', id: `fc_${index}`, call_id: call.id, name, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: `fc_${index}`, output_index: index + 1, delta: input.slice(0, 6) },
      { type: 'response.function_call_arguments.delta', item_id: `fc_${index}`, output_index: index + 1, delta: input.slice(6) },
      { type: 'response.output_item.done', output_index: index + 1, item: { type: 'function_call', id: `fc_${index}`, call_id: call.id, name, arguments: input, status: 'completed' } },
    ]),
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
  ].map(frame).join('');
  if (protocol === 'anthropic') {
    const offset = options.redacted ? 2 : 1;
    return [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'tool-fixture', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检索资料🙂' } },
      ...(options.signature ?? ['fixture-', 'signature']).map((signature) => ({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } })),
      { type: 'content_block_stop', index: 0 },
      ...(options.redacted ? [{ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-fixture' } }, { type: 'content_block_stop', index: 1 }] : []),
      ...calls.flatMap((call, index) => [
        { type: 'content_block_start', index: index + offset, content_block: { type: 'tool_use', id: call.id, name, input: {} } },
        { type: 'content_block_delta', index: index + offset, delta: { type: 'input_json_delta', partial_json: input.slice(0, 6) } },
        { type: 'content_block_delta', index: index + offset, delta: { type: 'input_json_delta', partial_json: input.slice(6) } },
        { type: 'content_block_stop', index: index + offset },
      ]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ].map(frame).join('');
  }
  return frame({ candidates: [{ index: 0, content: { role: 'model', parts: calls.map((call, index) => ({ functionCall: { id: call.id, name, args: JSON.parse(input) },
    ...(index === 0 ? { thoughtSignature: 'fixture-signature' } : {}) })) }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } });
}

export function fragmentedToolBody(wire: string, size = 11) {
  const data = new TextEncoder().encode(wire); let at = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (at === data.length) controller.close(); else { controller.enqueue(data.subarray(at, at + size)); at = Math.min(data.length, at + size); }
  } });
}
