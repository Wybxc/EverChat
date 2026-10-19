import * as v from 'valibot';

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const providerFailureSchema = v.strictObject({
  stage: v.picklist(['connect', 'response', 'stream', 'protocol', 'tool', 'storage']),
  occurredAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000)),
  protocol: v.optional(v.picklist(['openai-chat', 'openai-responses', 'anthropic', 'gemini'])),
  providerId: v.optional(text(64)),
  providerName: v.optional(text(100)),
  model: v.optional(text(200)),
  modelName: v.optional(text(200)),
  endpoint: v.optional(
    v.pipe(
      text(2048),
      v.check((value) => {
        try {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    ),
  ),
  status: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
  code: v.optional(text(128)),
  type: v.optional(text(128)),
  message: v.optional(text(4096)),
  requestId: v.optional(text(200)),
  retryAfter: v.optional(text(100)),
  truncated: v.optional(v.boolean()),
});
export type ProviderFailure = v.InferOutput<typeof providerFailureSchema>;
