import type { UIMessage } from 'ai';
import * as v from 'valibot';
import type { DocumentPart } from '../attachments/documents';
import type { ImagePart } from '../attachments/images';
import { AppError, problem } from '../errors/descriptor';
import { generationSchema } from '../streaming/generation';
import {
  WEB_TOOL_NAMES,
  publicToolTaskSchema,
  validateWebToolCandidate,
  validateWebToolOutcome,
  type PublicToolCall,
  type WebToolOutcome,
} from '../web-tools/tasks';
import type { SummaryCoverage } from './summaries';

const label = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const publicMessageMetadataSchema = v.strictObject({
  createdAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  providerId: v.optional(v.nullable(label(64))),
  providerName: v.optional(v.nullable(label(100))),
  model: v.optional(v.nullable(label(200))),
  modelName: v.optional(v.nullable(label(200))),
  generation: v.optional(generationSchema),
  error: v.optional(v.nullable(label(4096))),
});
export type PublicMessageMetadata = v.InferOutput<typeof publicMessageMetadataSchema>;
export type EverChatDataParts = {
  image: ImagePart;
  document: DocumentPart;
  summary: SummaryCoverage;
};
export type EverChatTools = {
  web_search: { input: { query: string }; output: WebToolOutcome };
  read_webpage: { input: { url: string }; output: WebToolOutcome };
};
export type EverChatUIMessage = UIMessage<PublicMessageMetadata, EverChatDataParts, EverChatTools>;
export type EverChatUIPart = EverChatUIMessage['parts'][number];

const toolMetadataSchema = v.strictObject({
  round: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  state: v.picklist(['queued', 'running', 'completed', 'failed', 'cancelled']),
  invalid: v.optional(v.literal(true)),
  // Their complete business schemas are checked with the reconstructed outcome.
  issue: v.optional(v.unknown()),
  failure: v.optional(v.unknown()),
});

function invalid(): never {
  throw new AppError(problem('STREAM_INVALID'), '公开消息内容无效。');
}
/** Reuse execution-journal validation without making public messages executable. */
export function toolCallFromUIPart(part: EverChatUIPart): PublicToolCall {
  if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) invalid();
  if (!('toolCallId' in part) || !('input' in part)) invalid();
  const metadata = v.parse(toolMetadataSchema, part.toolMetadata);
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
  if (
    !['input-available', 'output-available', 'output-error'].includes(part.state) ||
    (metadata.invalid && (part.type !== 'dynamic-tool' || part.state !== 'output-error')) ||
    (!metadata.invalid && part.type === 'dynamic-tool')
  )
    invalid();
  const candidate = validateWebToolCandidate(
    {
      id: part.toolCallId,
      name,
      input: part.input,
      ...(metadata.invalid
        ? { invalid: true, error: 'errorText' in part ? part.errorText : undefined }
        : {}),
    },
    WEB_TOOL_NAMES,
  );
  const result =
    part.state === 'output-available'
      ? validateWebToolOutcome(part.output)
      : part.state === 'output-error' && metadata.state === 'failed'
        ? validateWebToolOutcome({
            id: part.toolCallId,
            name,
            status: 'failed',
            error: part.errorText,
            ...(metadata.issue !== undefined ? { issue: metadata.issue } : {}),
            ...(metadata.failure !== undefined ? { failure: metadata.failure } : {}),
          })
        : undefined;
  if (
    (part.state === 'input-available' && !['queued', 'running'].includes(metadata.state)) ||
    (part.state === 'output-available' && metadata.state !== 'completed') ||
    (part.state === 'output-error' && !['failed', 'cancelled'].includes(metadata.state)) ||
    ((part.state !== 'output-error' || metadata.state === 'cancelled') &&
      (metadata.issue !== undefined || metadata.failure !== undefined))
  )
    invalid();
  const task = v.parse(publicToolTaskSchema, {
    status: 'active',
    round: metadata.round,
    calls: [
      {
        round: metadata.round,
        call: candidate,
        state: metadata.state,
        ...(result ? { result } : {}),
      },
    ],
  });
  return task.calls[0] as PublicToolCall;
}

/** Only complete, identified calls enter canonical parts, never partial arguments. */
export function toolUIPart(value: PublicToolCall): EverChatUIPart {
  const item = v.parse(publicToolTaskSchema, {
    status: 'active',
    round: value.round,
    calls: [value],
  }).calls[0] as PublicToolCall;
  const result = item.result;
  const common = {
    type: item.call.invalid ? 'dynamic-tool' : `tool-${item.call.name}`,
    ...(item.call.invalid ? { toolName: item.call.name } : {}),
    toolCallId: item.call.id,
    input: item.call.input,
    toolMetadata: {
      round: item.round,
      state: item.state,
      ...(item.call.invalid ? { invalid: true } : {}),
      ...(result?.status === 'failed' ? { issue: result.issue, failure: result.failure } : {}),
    },
  };
  return {
    ...common,
    ...(item.state === 'completed'
      ? { state: 'output-available', output: result }
      : ['failed', 'cancelled'].includes(item.state)
        ? {
            state: 'output-error',
            errorText: result?.status === 'failed' ? result.error : '工具已停止。',
          }
        : { state: 'input-available' }),
  } as EverChatUIPart;
}
