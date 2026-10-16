import type { ProviderConfig } from '../../shared/providers/types';
import { ProviderStream } from '../../shared/streaming/provider-stream';
import { MAX_TOOL_TURN_WIRE_BYTES } from '../providers/tool-turn';
import { ProviderError } from '../generation/errors';

// Tool responses include private continuation material. Only text/reasoning/usage
// become display SSE; the original bytes use a separate, server-only journal.
export class ToolStreamRelay {
  private readonly parser: ProviderStream;
  private readonly encoder = new TextEncoder();
  private received = 0;
  constructor(
    config: Pick<ProviderConfig, 'provider' | 'showReasoning'>,
    private readonly privateBytes: (bytes: Uint8Array) => void,
    private readonly displayBytes: (bytes: Uint8Array) => void,
  ) {
    this.parser = new ProviderStream(config.provider, config.showReasoning === true);
  }
  private event(value: unknown) {
    this.displayBytes(this.encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  }
  private deltas() {
    for (const delta of this.parser.drainDeltas())
      this.event({
        choices: [
          {
            index: 0,
            delta: {
              [delta.kind === 'content' ? 'content' : 'reasoning_content']: delta.text,
            },
          },
        ],
      });
  }
  add(bytes: Uint8Array) {
    if ((this.received += bytes.byteLength) > MAX_TOOL_TURN_WIRE_BYTES)
      throw new ProviderError('工具响应超过 2 MiB 的原型限制。');
    this.privateBytes(bytes);
    this.parser.feed(bytes);
    this.deltas();
    if (this.parser.failed) throw new ProviderError(this.parser.checkpoint().failure!);
  }
  end() {
    this.parser.assertEnded();
    this.deltas();
    const state = this.parser.checkpoint(),
      usage = state.usage;
    this.event({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            state.finishReason === 'length'
              ? 'length'
              : state.finishReason === 'other'
                ? 'tool_calls'
                : 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
        completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
      },
    });
    this.displayBytes(this.encoder.encode('data: [DONE]\n\n'));
  }
}
