import * as v from 'valibot';

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const providerFailureSchema = v.strictObject({
  stage: v.picklist(['connect', 'response', 'stream', 'protocol', 'tool']),
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

export const failureStages: Record<ProviderFailure['stage'], string> = {
  connect: '连接供应商',
  response: '供应商响应',
  stream: '供应商流式响应',
  protocol: '解析供应商响应',
  tool: '工具执行',
};

export function failureEntries(failure: ProviderFailure): [string, string][] {
  return [
    ['阶段', failureStages[failure.stage]],
    ['供应商', failure.providerName ?? failure.providerId],
    ['协议', failure.protocol],
    [
      '模型',
      failure.modelName && failure.model && failure.modelName !== failure.model
        ? `${failure.modelName} (${failure.model})`
        : failure.modelName || failure.model,
    ],
    ['端点', failure.endpoint],
    ['HTTP', failure.status?.toString()],
    ['错误代码', failure.code],
    ['错误类型', failure.type],
    ['供应商信息', failure.message],
    ['请求 ID', failure.requestId],
    ['Retry-After', failure.retryAfter],
    ['时间', new Date(failure.occurredAt).toISOString()],
    ['截断', failure.truncated ? '响应过长，仅保留部分诊断' : undefined],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]));
}

export function failureDiagnosticText(summary: string, failure: ProviderFailure): string {
  return [summary, ...failureEntries(failure).map(([label, value]) => `${label}: ${value}`)].join(
    '\n',
  );
}
