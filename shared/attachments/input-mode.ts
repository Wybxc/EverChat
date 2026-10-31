import { canAttemptCapability } from '../models/metadata';
import type { ProviderConfig, ChatInput } from '../providers/types';
import { documentTokens, DocumentError, type DocumentPart } from './documents';

// A UX threshold, not a storage or upload limit. Explicit inline always wins.
export const AUTO_INLINE_TOKENS = 8192;
export function resolveDocumentModes(
  groups: DocumentPart[][],
  config: Pick<ProviderConfig, 'modelMetadata'>,
  budget: number,
) {
  let remaining = Math.max(0, budget);
  const tools = canAttemptCapability(config.modelMetadata, 'toolCalls');
  // Reserve explicit inline files before deciding all automatic files together.
  for (const group of groups)
    for (const file of group) if (file.inputMode === 'inline') remaining -= file.tokens;
  return groups.map((group) =>
    group.map((file) => {
      const mode = file.inputMode ?? 'auto';
      if (mode === 'on_demand' && !tools)
        throw new DocumentError('当前模型不支持附件按需读取工具，请使用全文或更换模型。');
      const onDemand =
        mode === 'on_demand' ||
        (mode === 'auto' && tools && (file.tokens > AUTO_INLINE_TOKENS || file.tokens > remaining));
      const result = { ...file, delivery: onDemand ? ('on_demand' as const) : ('inline' as const) };
      if (mode !== 'inline') remaining -= documentTokens([result]);
      return result;
    }),
  );
}

export const hasOnDemandFiles = (context: ChatInput[]) =>
  context.some((m) => m.files?.some((f) => f.delivery === 'on_demand'));
