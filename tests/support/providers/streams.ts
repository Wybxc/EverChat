import type { ProviderKind } from '../../../shared/providers/types';
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
export const providerStreams: Record<ProviderKind, { partial: string; finish: string }> = {
  'openai-chat': {
    partial: frame({
      choices: [
        {
          index: 0,
          delta: { reasoning_content: '**思考🙂**\n', content: '**正文🙂**\n' },
          finish_reason: null,
        },
      ],
    }),
    finish:
      frame({
        choices: [
          {
            index: 0,
            delta: { reasoning_content: '结论。', content: '答案。' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }) + 'data: [DONE]\r\n\r\n',
  },
  'openai-responses': {
    partial:
      frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'thought', summary: [], content: [] },
      }) +
      frame({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'answer', content: [] },
      }) +
      frame({
        type: 'response.reasoning_text.delta',
        item_id: 'thought',
        content_index: 0,
        delta: '**思考🙂**\n',
      }) +
      frame({
        type: 'response.output_text.delta',
        item_id: 'answer',
        output_index: 1,
        content_index: 0,
        delta: '**正文🙂**\n',
      }),
    finish:
      frame({
        type: 'response.reasoning_text.delta',
        item_id: 'thought',
        content_index: 0,
        delta: '结论。',
      }) +
      frame({
        type: 'response.reasoning_text.done',
        item_id: 'thought',
        content_index: 0,
        text: '**思考🙂**\n结论。',
      }) +
      frame({
        type: 'response.output_text.delta',
        item_id: 'answer',
        output_index: 1,
        content_index: 0,
        delta: '答案。',
      }) +
      frame({
        type: 'response.output_text.done',
        item_id: 'answer',
        output_index: 1,
        content_index: 0,
        text: '**正文🙂**\n答案。',
      }) +
      frame({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
          incomplete_details: null,
        },
      }),
  },
  anthropic: {
    partial:
      frame({
        type: 'message_start',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } },
      }) +
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '**思考🙂**\n' },
      }) +
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
      frame({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '**正文🙂**\n' },
      }),
    finish:
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '结论。' },
      }) +
      frame({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '答案。' },
      }) +
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'not-displayed' },
      }) +
      frame({ type: 'content_block_stop', index: 0 }) +
      frame({ type: 'content_block_stop', index: 1 }) +
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }) +
      frame({ type: 'message_stop' }),
  },
  gemini: {
    partial: frame({
      candidates: [
        {
          index: 0,
          content: { parts: [{ thought: true, text: '**思考🙂**\n' }, { text: '**正文🙂**\n' }] },
        },
      ],
    }),
    finish: frame({
      candidates: [
        {
          index: 0,
          content: { parts: [{ thought: true, text: '结论。' }, { text: '答案。' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 4,
        thoughtsTokenCount: 2,
      },
    }),
  },
};

// Public application events, intentionally independent of native supplier wires.
export const applicationStreams = Object.fromEntries(
  Object.keys(providerStreams).map((kind) => {
    const event = (value: unknown) => JSON.stringify(value) + '\n';
    return [
      kind,
      {
        partial:
          event({ type: 'text', text: '**正文🙂**\n' }) +
          event({ type: 'reasoning', text: '**思考🙂**\n' }),
        finish:
          event({ type: 'reasoning', text: '结论。' }) +
          event({ type: 'text', text: '答案。' }) +
          event({
            type: 'finish',
            reason: 'stop',
            usage: {
              inputTokens: kind === 'anthropic' ? 14 : 10,
              outputTokens: kind === 'gemini' ? 7 : 5,
              cachedInputTokens: 4,
            },
            usageIsFinal: true,
          }),
      },
    ];
  }),
) as typeof providerStreams;
