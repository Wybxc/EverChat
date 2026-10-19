import type { ModelMetadata, ProviderModel, ResolvedModelMetadata } from './types';
import type { ProviderApiKind } from '../providers/types';
import { matchModelCatalog } from './catalog';

export const MAX_MODEL_TOKENS = 10_000_000;
export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const FALLBACK_MODEL_METADATA: Readonly<ModelMetadata> = {
  contextWindow: 32_768,
  contextScope: 'combined',
  maxOutputTokens: 8_192,
  imageInput: false,
  toolCalls: false,
  structuredOutput: false,
  reasoning: false,
  reasoningEfforts: ['low', 'medium', 'high'],
};

// Exact IDs only. Official references, scope and verification date: docs/model-metadata.md.
// A model family prefix cannot establish the limits or capabilities of an unknown model.
const openai: Record<string, Partial<ModelMetadata>> = {
  o3: {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  'gpt-4o-mini': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: false,
  },
  'gpt-4o': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: false,
  },
  'gpt-4o-2024-08-06': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: false,
  },
  'gpt-5': {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  'gpt-5-2025-08-07': {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  'gpt-5.4': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  'gpt-5.4-2026-03-05': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  'gpt-6-sol': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  'gpt-6-luna': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  'gpt-6-astra': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'gpt-6.1-sol': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    imageInput: true,
    toolCalls: true,
    structuredOutput: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
};
function catalog(provider: ProviderApiKind, id: string): Partial<ModelMetadata> {
  if (provider.startsWith('openai-')) {
    if (id === 'deepseek-flash' || id === 'deepseek-v4-pro')
      return {
        contextWindow: 1_000_000,
        contextScope: 'combined',
        maxOutputTokens: 393_216,
        imageInput: id === 'deepseek-flash',
        toolCalls: true,
        structuredOutput: false,
        reasoning: true,
        reasoningEfforts: ['none', 'low', 'high', 'max'],
      };
    const known = Object.hasOwn(openai, id) ? openai[id] : undefined;
    return known
      ? {
          contextScope: 'combined',
          ...known,
          ...(provider === 'openai-chat' && (id === 'gpt-6-astra' || id === 'gpt-6.1-sol')
            ? { toolCalls: false }
            : {}),
        }
      : {};
  }
  if (provider === 'gemini' && id === 'gemini-2.5-flash')
    return {
      contextWindow: 1_048_576,
      contextScope: 'input',
      maxOutputTokens: 65_536,
      imageInput: true,
      toolCalls: true,
      structuredOutput: true,
      reasoning: true,
      reasoningEfforts: ['none', 'low', 'medium', 'high'],
    };
  return {};
}

export function resolveModelMetadata(
  provider: ProviderApiKind,
  model: ProviderModel,
): ResolvedModelMetadata {
  const known = catalog(provider, model.id);
  // Drafts use undefined to restore individual fields to automatic inheritance.
  const defined = (values?: Partial<ModelMetadata>) =>
    Object.fromEntries(
      Object.entries(values ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<ModelMetadata>;
  const matched = model.directoryMetadata ?? matchModelCatalog(provider, model.id);
  const directory = defined(matched?.values);
  if (matched?.match === 'alias') {
    for (const field of [
      'contextWindow',
      'contextScope',
      'maxOutputTokens',
      'reasoningEfforts',
    ] as const)
      delete directory[field];
  }
  const tested = model.testedCapabilities;
  const automatic = {
    ...directory,
    ...known,
    ...(tested?.imageInput ? { imageInput: true } : {}),
    ...(tested?.toolCalls ? { toolCalls: true } : {}),
    ...defined(model.reportedMetadata),
  };
  const overrides: Partial<ModelMetadata> = {
    ...defined(model.metadataOverrides),
    ...(model.reasoningSupport === 'supported'
      ? { reasoning: true }
      : model.reasoningSupport === 'unsupported'
        ? { reasoning: false }
        : {}),
  };
  const sources = {} as ResolvedModelMetadata['sources'];
  for (const key of Object.keys(FALLBACK_MODEL_METADATA) as (keyof ModelMetadata)[]) {
    sources[key] =
      overrides[key] !== undefined
        ? 'manual'
        : model.reportedMetadata?.[key] !== undefined
          ? 'provider'
          : (key === 'imageInput' || key === 'toolCalls') && tested?.[key]
            ? 'tested'
            : known[key] !== undefined
              ? 'catalog'
              : directory[key] !== undefined
                ? matched?.match === 'alias'
                  ? 'inferred'
                  : 'directory'
                : 'fallback';
  }
  const resolved = { ...FALLBACK_MODEL_METADATA, ...automatic, ...overrides, sources };
  // Copy arrays so editing provider settings cannot change a previously accepted run.
  return {
    ...resolved,
    reasoningEfforts:
      resolved.reasoning &&
      (sources.reasoningEfforts !== 'fallback' || model.reasoningSupport === 'supported')
        ? [...resolved.reasoningEfforts]
        : [],
  };
}

// This only permits requests the user has chosen; it never enables tools or starts requests.
export function canAttemptCapability(
  metadata: ResolvedModelMetadata | undefined,
  field: 'imageInput' | 'toolCalls',
): boolean {
  return Boolean(
    metadata &&
    (metadata[field] ||
      metadata.sources[field] === 'fallback' ||
      metadata.sources[field] === 'inferred'),
  );
}

export function validateOutputLimit(
  metadata: ResolvedModelMetadata | undefined,
  limit: number | null,
): void {
  if (!metadata || limit === null) return;
  // A fallback is a planning estimate, not an authoritative supplier rejection threshold.
  if (metadata.sources.maxOutputTokens !== 'fallback' && limit > metadata.maxOutputTokens) {
    throw new Error(
      `当前模型的输出上限不能超过 ${metadata.maxOutputTokens.toLocaleString('en-US')} Tokens。`,
    );
  }
  if (
    metadata.contextScope === 'combined' &&
    metadata.sources.contextWindow !== 'fallback' &&
    limit > metadata.contextWindow
  ) {
    throw new Error(
      `输出上限不能超过当前模型的上下文窗口（${metadata.contextWindow.toLocaleString('en-US')} Tokens）。`,
    );
  }
}
