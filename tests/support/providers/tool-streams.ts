import type { ProviderKind } from '../../../shared/providers/types';

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
export const toolQuery = 'Cloudflare 文档🙂';

export type GeminiToolSignatureAt =
  'start' | 'delta' | 'empty-delta' | 'final-delta' | 'end' | 'none';
export function geminiStreamingToolStream(signatureAt: GeminiToolSignatureAt, id = 'call_0') {
  const signature = { thoughtSignature: `fixture-${id}-signature` };
  const chunks = [
    {
      functionCall: {
        id,
        name: 'web_search',
        partialArgs: [{ jsonPath: '$.query', stringValue: 'Cloudflare ' }],
        willContinue: true,
      },
      ...(signatureAt === 'start' ? signature : {}),
    },
    {
      functionCall: {
        partialArgs: [{ jsonPath: '$.query', stringValue: '文档🙂' }],
        willContinue: true,
      },
      ...(signatureAt === 'delta' ? signature : {}),
    },
    ...(signatureAt === 'empty-delta'
      ? [{ functionCall: { partialArgs: [], willContinue: true }, ...signature }]
      : []),
    signatureAt === 'final-delta'
      ? { functionCall: { partialArgs: [], willContinue: false }, ...signature }
      : { functionCall: {}, ...(signatureAt === 'end' ? signature : {}) },
  ];
  return chunks
    .map((part, index) =>
      frame({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [part] },
            ...(index === chunks.length - 1 ? { finishReason: 'STOP' } : {}),
          },
        ],
        ...(index === chunks.length - 1
          ? { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } }
          : {}),
      }),
    )
    .join('');
}

export function toolStream(
  protocol: ProviderKind,
  options: {
    reasoning?: string;
    name?: string;
    input?: string;
    count?: number;
    duplicate?: boolean;
    redacted?: boolean;
    signature?: string[];
    calls?: { name: string; input: string }[];
  } = {},
) {
  const reasoning = options.reasoning ?? '检索资料🙂';
  const name = options.name ?? 'web_search',
    input = options.input ?? JSON.stringify({ query: toolQuery });
  const calls = (
    options.calls ?? Array.from({ length: options.count ?? 1 }, () => ({ name, input }))
  ).map((call, index) => ({ id: `call_${options.duplicate ? 0 : index}`, ...call }));
  if (protocol === 'openai-chat')
    return (
      [
        { choices: [{ index: 0, delta: { reasoning_content: reasoning } }] },
        ...calls.flatMap((call, index) => [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.input.slice(0, 6) },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index, function: { arguments: call.input.slice(6) } }] },
              },
            ],
          },
        ]),
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
      ]
        .map(frame)
        .join('') + 'data: [DONE]\n\n'
    );
  if (protocol === 'openai-responses')
    return [
      {
        type: 'response.created',
        response: { id: 'resp_fixture', created_at: 1, model: 'tool-fixture' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: null },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_fixture',
        output_index: 0,
        summary_index: 0,
        delta: reasoning,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_fixture',
          encrypted_content: 'encrypted-fixture',
          summary: [{ type: 'summary_text', text: reasoning }],
        },
      },
      ...calls.flatMap((call, index) => [
        {
          type: 'response.output_item.added',
          output_index: index + 1,
          item: {
            type: 'function_call',
            id: `fc_${index}`,
            call_id: call.id,
            name: call.name,
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: `fc_${index}`,
          output_index: index + 1,
          delta: call.input.slice(0, 6),
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: `fc_${index}`,
          output_index: index + 1,
          delta: call.input.slice(6),
        },
        {
          type: 'response.output_item.done',
          output_index: index + 1,
          item: {
            type: 'function_call',
            id: `fc_${index}`,
            call_id: call.id,
            name: call.name,
            arguments: call.input,
            status: 'completed',
          },
        },
      ]),
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
    ]
      .map(frame)
      .join('');
  if (protocol === 'anthropic') {
    const offset = options.redacted ? 2 : 1;
    return [
      {
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'tool-fixture',
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: reasoning },
      },
      ...(options.signature ?? ['fixture-', 'signature']).map((signature) => ({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature },
      })),
      { type: 'content_block_stop', index: 0 },
      ...(options.redacted
        ? [
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'redacted_thinking', data: 'redacted-fixture' },
            },
            { type: 'content_block_stop', index: 1 },
          ]
        : []),
      ...calls.flatMap((call, index) => [
        {
          type: 'content_block_start',
          index: index + offset,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index: index + offset,
          delta: { type: 'input_json_delta', partial_json: call.input.slice(0, 6) },
        },
        {
          type: 'content_block_delta',
          index: index + offset,
          delta: { type: 'input_json_delta', partial_json: call.input.slice(6) },
        },
        { type: 'content_block_stop', index: index + offset },
      ]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
      .map(frame)
      .join('');
  }
  return frame({
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [
            ...(options.reasoning !== undefined ? [{ text: reasoning, thought: true }] : []),
            ...calls.map((call, index) => ({
              functionCall: { id: call.id, name: call.name, args: JSON.parse(call.input) },
              ...(index === 0 ? { thoughtSignature: 'fixture-signature' } : {}),
            })),
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  });
}

export function fragmentedToolBody(wire: string, size = 11) {
  const data = new TextEncoder().encode(wire);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === data.length) controller.close();
      else {
        controller.enqueue(data.subarray(at, at + size));
        at = Math.min(data.length, at + size);
      }
    },
  });
}

export function toolFinalStream(
  protocol: ProviderKind,
  workload?: { chunks: number; size: number },
  reasoning?: string,
) {
  const pieces = workload
    ? Array.from({ length: workload.chunks }, () => 'x'.repeat(workload.size - 2) + '🙂')
    : ['**工具回答🙂**\n结论。'];
  const text = pieces.join('');
  if (protocol === 'openai-chat')
    return (
      (reasoning
        ? frame({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] })
        : '') +
      pieces.map((content) => frame({ choices: [{ index: 0, delta: { content } }] })).join('') +
      frame({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }) +
      'data: [DONE]\n\n'
    );
  if (protocol === 'openai-responses')
    return [
      {
        type: 'response.created',
        response: { id: 'resp_final', created_at: 1, model: 'tool-fixture' },
      },
      ...(reasoning
        ? [
            {
              type: 'response.output_item.added',
              output_index: 1,
              item: { type: 'reasoning', id: 'rs_final', encrypted_content: null },
            },
            {
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs_final',
              output_index: 1,
              summary_index: 0,
              delta: reasoning,
            },
            {
              type: 'response.output_item.done',
              output_index: 1,
              item: {
                type: 'reasoning',
                id: 'rs_final',
                encrypted_content: 'encrypted-fixture',
                summary: [{ type: 'summary_text', text: reasoning }],
              },
            },
          ]
        : []),
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_final',
          role: 'assistant',
          content: [],
          status: 'in_progress',
        },
      },
      {
        type: 'response.content_part.added',
        item_id: 'msg_final',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      ...pieces.map((delta) => ({
        type: 'response.output_text.delta',
        item_id: 'msg_final',
        output_index: 0,
        content_index: 0,
        delta,
      })),
      {
        type: 'response.output_text.done',
        item_id: 'msg_final',
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: 'response.content_part.done',
        item_id: 'msg_final',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_final',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          incomplete_details: null,
        },
      },
    ]
      .map(frame)
      .join('');
  if (protocol === 'anthropic')
    return [
      {
        type: 'message_start',
        message: {
          id: 'msg_final',
          type: 'message',
          role: 'assistant',
          model: 'tool-fixture',
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      ...(reasoning
        ? [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: reasoning },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'fixture-signature' },
            },
            { type: 'content_block_stop', index: 0 },
          ]
        : []),
      {
        type: 'content_block_start',
        index: reasoning ? 1 : 0,
        content_block: { type: 'text', text: '' },
      },
      ...pieces.map((text) => ({
        type: 'content_block_delta',
        index: reasoning ? 1 : 0,
        delta: { type: 'text_delta', text },
      })),
      { type: 'content_block_stop', index: reasoning ? 1 : 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
      .map(frame)
      .join('');
  return (
    (reasoning
      ? frame({
          candidates: [
            {
              index: 0,
              content: {
                role: 'model',
                parts: [{ text: reasoning, thought: true, thoughtSignature: 'fixture-signature' }],
              },
            },
          ],
        })
      : '') +
    pieces
      .map((text, index) =>
        frame({
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text }] },
              ...(index === pieces.length - 1 ? { finishReason: 'STOP' } : {}),
            },
          ],
          ...(index === pieces.length - 1
            ? {
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15,
                },
              }
            : {}),
        }),
      )
      .join('')
  );
}
