import { createHash } from 'node:crypto';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import type { InputReceiptItem } from '../../shared/streaming/input-receipt';
import type { ProviderToolRequest } from './tool-turn';
import { webToolDefinitions } from './tool-turn';
import { documentKey } from '../../shared/attachments/documents';
import {
  SUMMARY_CONTEXT_PREFIX,
  SUMMARY_CONTEXT_SUFFIX,
} from '../../shared/conversation/summaries';

export const inputHash = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
export interface AssembledInput {
  items: { item: InputReceiptItem; snapshot?: string }[];
  tools: string[];
  toolDefinitionsSha256: string | null;
}
export interface SubmittedInput extends AssembledInput {
  requestSha256: string;
  requestBytes: number;
}

/** Public logical inputs only. Never retain SDK providerOptions or the HTTP body. */
export function assembledInput(
  config: ProviderConfig,
  context: ChatInput[],
  toolRequest?: ProviderToolRequest,
  documentData?: Map<string, string>,
): AssembledInput {
  const items: AssembledInput['items'] = [];
  const text = (
    kind: InputReceiptItem['kind'],
    role: InputReceiptItem['role'],
    value: string,
    sourceId: string | null,
  ) => {
    const snapshot = kind === 'generated' || (kind === 'system' && config.receiptSystemPrompt);
    items.push({
      item: {
        kind,
        role,
        sourceId,
        sha256: inputHash(value),
        characters: value.length,
        bytes: Buffer.byteLength(value),
        content: snapshot ? 'snapshot' : kind === 'system' ? 'redacted' : 'reference',
        scope: 'logical_input',
        ...(kind === 'summary'
          ? { transform: { prefix: SUMMARY_CONTEXT_PREFIX, suffix: SUMMARY_CONTEXT_SUFFIX } }
          : {}),
      },
      ...(snapshot ? { snapshot: value } : {}),
    });
  };
  const base = !toolRequest?.exchanges?.length;
  if (base && config.systemPrompt) text('system', 'system', config.systemPrompt, null);
  for (const message of base ? context : []) {
    text(
      message.source?.kind ?? 'generated',
      message.role,
      message.content,
      message.source?.messageId ?? null,
    );
    for (const file of message.files ?? []) {
      const injected = documentData?.get(documentKey(file));
      if (injected === undefined) throw new Error('Document input evidence is unavailable');
      items.push({
        item: {
          kind: 'document',
          role: message.role,
          sourceId: message.source?.messageId ?? null,
          sha256: inputHash(injected),
          characters: injected.length,
          bytes: null,
          content: 'metadata_only',
          scope: 'logical_input',
          attachment: {
            ...file,
            verification: 'extracted_text_verified',
            delivery: 'extracted_text',
            originalVerification: 'client_declared',
          },
        },
      });
    }
    for (const image of message.images ?? [])
      items.push({
        item: {
          kind: 'image',
          role: message.role,
          sourceId: message.source?.messageId ?? null,
          sha256: image.sha256,
          characters: null,
          bytes: image.size,
          content: 'metadata_only',
          scope: 'logical_input',
          attachment: { ...image, verification: 'original_verified', delivery: 'image_bytes' },
        },
      });
  }
  // The store references the previous step for earlier tool exchanges. Record
  // only the new exchange, with public input/output and no private reasoning.
  const exchange = toolRequest?.exchanges?.at(-1);
  if (exchange) {
    const publicExchange = {
      calls: exchange.turn.calls,
      outcomes: exchange.outcomes,
      text: exchange.turn.content.filter((part) => part.type === 'text').map((part) => part.text),
    };
    const value = JSON.stringify(publicExchange);
    items.push({
      item: {
        kind: 'tool',
        role: 'tool',
        sourceId: null,
        sha256: inputHash(value),
        characters: value.length,
        bytes: Buffer.byteLength(value),
        content: 'snapshot',
        scope: 'public_projection',
      },
      snapshot: value,
    });
  }
  return {
    items,
    tools: [...(toolRequest?.enabled ?? [])],
    toolDefinitionsSha256: toolRequest
      ? inputHash(JSON.stringify(webToolDefinitions(toolRequest.enabled, config)))
      : null,
  };
}
