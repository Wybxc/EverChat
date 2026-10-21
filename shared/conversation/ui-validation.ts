import { jsonSchema, validateUIMessages } from 'ai';
import * as v from 'valibot';
import { documentPartSchema, MAX_MESSAGE_DOCUMENTS } from '../attachments/documents';
import { imagePartSchema, MAX_MESSAGE_IMAGES } from '../attachments/images';
import { AppError, problem } from '../errors/descriptor';
import { MAX_TOOL_CALLS_PER_TURN, publicWebUrl, webToolInputSchemas } from '../web-tools/tasks';
import { MAX_MESSAGE_TEXT_BYTES, messageTextFits } from './limits';
import { summaryCoverageSchema } from './summaries';
import {
  publicMessageMetadataSchema,
  toolCallFromUIPart,
  type EverChatUIMessage,
} from './ui-message';

// This is a UI validation schema, never a schema sent to a model. The pinned
// SDK's Standard Schema adapter accepts a Valibot result with value AND issues;
// safeParse's explicit success flag must remain the acceptance condition.
function uiSchema<S extends v.GenericSchema>(schema: S) {
  return jsonSchema<v.InferOutput<S>>(
    {},
    {
      validate(value) {
        const parsed = v.safeParse(schema, value);
        return parsed.success
          ? { success: true, value: parsed.output }
          : { success: false, error: new Error('Public message schema validation failed') };
      },
    },
  );
}
const dataSchemas = {
  image: uiSchema(imagePartSchema),
  document: uiSchema(documentPartSchema),
  summary: uiSchema(summaryCoverageSchema),
};
const tools = {
  web_search: { inputSchema: uiSchema(webToolInputSchemas.web_search) },
  read_webpage: { inputSchema: uiSchema(webToolInputSchemas.read_webpage) },
};

function invalid(): never {
  throw new AppError(problem('STREAM_INVALID'), '公开消息内容无效。');
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const [key, field] of Object.entries(value))
    if (field !== undefined && !allowed.includes(key)) invalid();
}

/** SDK validation permits private provider metadata; this public contract does not. */
function assertPublicFields(value: unknown) {
  keys(value, ['id', 'role', 'parts', 'metadata']);
  if (!Array.isArray(value.parts) || value.role === 'system') invalid();
  for (const part of value.parts) {
    if (!part || typeof part !== 'object') invalid();
    const type = part.type;
    if (type === 'text') keys(part, ['type', 'text', 'state']);
    else if (type === 'reasoning') keys(part, ['type', 'id', 'text', 'state']);
    else if (type === 'step-start') keys(part, ['type']);
    else if (type === 'source-url') {
      keys(part, ['type', 'sourceId', 'url', 'title']);
      if (typeof part.url !== 'string' || !publicWebUrl(part.url)) invalid();
    } else if (type === 'data-image' || type === 'data-document' || type === 'data-summary')
      keys(part, ['type', 'id', 'data']);
    else if (type === 'dynamic-tool' || type === 'tool-web_search' || type === 'tool-read_webpage')
      keys(part, [
        'type',
        ...(type === 'dynamic-tool' ? ['toolName'] : []),
        'toolCallId',
        'state',
        'input',
        'output',
        'errorText',
        'toolMetadata',
      ]);
    else invalid();
    if (value.role === 'user' && !['text', 'data-image', 'data-document'].includes(type)) invalid();
    if (value.role === 'assistant' && ['data-image', 'data-document'].includes(type)) invalid();
  }
}

/** SDK owns standard part validation; EverChat limits the public surface and references. */
async function validateMessage(value: unknown): Promise<EverChatUIMessage> {
  assertPublicFields(value);
  const [message] = await validateUIMessages<EverChatUIMessage>({
    messages: [value],
    metadataSchema: uiSchema(v.optional(publicMessageMetadataSchema)),
    dataSchemas,
    tools,
  });
  if (!message.id || message.id.length > 256) invalid();
  let text = '',
    reasoning = '',
    images = 0,
    documents = 0;
  const references = new Set<string>(),
    calls = new Set<string>(),
    reasoningIds = new Set<string>(),
    rounds = new Map<number, number>();
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'reasoning') {
      if (!part.id || part.id.length > 256 || reasoningIds.has(part.id)) invalid();
      reasoningIds.add(part.id);
      reasoning += part.text;
    } else if (part.type === 'data-image' || part.type === 'data-document') {
      if (part.id !== part.data.attachmentId || references.has(part.id)) invalid();
      references.add(part.id);
      if (part.type === 'data-image') images++;
      else documents++;
    } else if (part.type === 'data-summary') {
      if (references.has('summary') || part.id !== 'summary') invalid();
      references.add('summary');
    } else if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      const item = toolCallFromUIPart(part);
      if (calls.has(item.call.id)) invalid();
      calls.add(item.call.id);
      const count = (rounds.get(item.round) ?? 0) + 1;
      if (count > MAX_TOOL_CALLS_PER_TURN) invalid();
      rounds.set(item.round, count);
    } else if (part.type === 'source-url') {
      if (!part.sourceId || part.sourceId.length > 256 || (part.title?.length ?? 0) > 300)
        invalid();
    }
    if (text.length + reasoning.length > MAX_MESSAGE_TEXT_BYTES) invalid();
  }
  if (
    images > MAX_MESSAGE_IMAGES ||
    documents > MAX_MESSAGE_DOCUMENTS ||
    !messageTextFits(text, reasoning)
  )
    invalid();
  return message;
}

export async function validatePublicUIMessage(value: unknown): Promise<EverChatUIMessage> {
  try {
    return await validateMessage(value);
  } catch {
    // SDK/schema error objects can embed the rejected input. Never expose that
    // object as a public stream error or accidentally log a private field.
    invalid();
  }
}
