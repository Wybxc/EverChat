import * as v from 'valibot';

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const inputReceiptItemSchema = v.strictObject({
  kind: v.picklist(['message', 'summary', 'system', 'generated', 'document', 'image', 'tool']),
  role: v.picklist(['system', 'user', 'assistant', 'tool']),
  sourceId: v.nullable(v.string()),
  sha256: hash,
  characters: v.nullable(count),
  bytes: v.nullable(count),
  content: v.picklist(['reference', 'snapshot', 'redacted', 'metadata_only']),
  scope: v.picklist(['logical_input', 'public_projection']),
  transform: v.optional(v.strictObject({ prefix: v.string(), suffix: v.string() })),
  attachment: v.optional(v.record(v.string(), v.unknown())),
});
export type InputReceiptItem = v.InferOutput<typeof inputReceiptItemSchema>;
export const inputReceiptSchema = v.strictObject({
  stepId: v.string(),
  messageId: v.string(),
  round: count,
  previousStepId: v.nullable(v.string()),
  assembledAt: count,
  submissionAttemptedAt: v.nullable(count),
  requestSha256: v.nullable(hash),
  requestBytes: v.nullable(count),
  protocol: v.picklist(['openai-chat', 'openai-responses', 'anthropic', 'gemini']),
  model: v.string(),
  estimatedInputTokens: v.nullable(count),
  estimateMethod: v.nullable(v.literal('approximate-v1')),
  maxOutputTokens: v.nullable(count),
  temperature: v.nullable(v.number()),
  topP: v.nullable(v.number()),
  reasoningEffort: v.nullable(v.string()),
  parameterEvidence: v.literal('application_requested'),
  tools: v.array(v.string()),
  toolDefinitionsSha256: v.nullable(hash),
  includedItems: count,
  omittedMessages: count,
  summarizedMessages: count,
  originStepId: v.nullable(v.string()),
});
export type InputReceipt = v.InferOutput<typeof inputReceiptSchema>;
export const contextSummarySchema = v.strictObject({
  state: v.picklist(['pending', 'assembled', 'submission_attempted', 'unavailable']),
  receiptRef: v.nullable(v.string()),
  steps: count,
  estimatedInputTokens: v.nullable(count),
  estimateMethod: v.nullable(v.literal('approximate-v1')),
  omittedMessages: v.nullable(count),
  summarizedMessages: v.nullable(count),
  includedItems: v.nullable(count),
  providerReceipt: v.literal('not_proven'),
});
export type ContextSummary = v.InferOutput<typeof contextSummarySchema>;
export const inputEvidenceBackupSchema = v.strictObject({
  selection: v.array(v.strictObject({ sourceId: v.nullable(v.string()), reason: v.string() })),
  steps: v.array(
    v.strictObject({
      receipt: inputReceiptSchema,
      items: v.array(
        v.strictObject({ item: inputReceiptItemSchema, snapshot: v.optional(v.string()) }),
      ),
    }),
  ),
});
export type InputEvidenceBackup = v.InferOutput<typeof inputEvidenceBackupSchema>;
