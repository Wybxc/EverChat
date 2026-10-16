import { MODEL_CATALOG_SNAPSHOT } from './generated/catalog';
import type { ModelMetadata, ProviderModel } from './types';
import type { ProviderApiKind } from '../providers/types';

export type ModelCatalog = Record<string, Record<string, Partial<ModelMetadata>>>;
const CATALOG_VENDORS = ['openai', 'anthropic', 'google', 'deepseek', 'moonshotai', 'alibaba', 'mistral', 'xai', 'zhipuai', 'minimax', 'cohere', 'meta', 'nvidia'] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000;
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Retain only fields used by EverChat. Missing booleans stay unknown.
export function parseModelCatalog(value: unknown): ModelCatalog {
  const input = object(value), catalog: ModelCatalog = {};
  for (const vendor of CATALOG_VENDORS) {
    const models: ModelCatalog[string] = {};
    for (const [id, raw] of Object.entries(object(object(input[vendor]).models)).slice(0, 2000)) {
      if (!/^[\w./:@+-]{1,200}$/.test(id) || id.toLowerCase() === '__proto__' || id.toLowerCase() === 'constructor') continue;
      const entry = object(raw), modalities = object(entry.modalities), limit = object(entry.limit);
      if (Array.isArray(modalities.output) && !modalities.output.includes('text')) continue;
      const metadata: Partial<ModelMetadata> = {};
      for (const [field, native] of [['toolCalls', 'tool_call'], ['reasoning', 'reasoning'], ['structuredOutput', 'structured_output']] as const) {
        if (typeof entry[native] === 'boolean') metadata[field] = entry[native];
      }
      if (Array.isArray(modalities.input) && modalities.input.length) metadata.imageInput = modalities.input.includes('image');
      if (positive(limit.context)) { metadata.contextWindow = limit.context; metadata.contextScope = 'combined'; }
      if (positive(limit.input)) { metadata.contextWindow = limit.input; metadata.contextScope = 'input'; }
      if (positive(limit.output)) metadata.maxOutputTokens = limit.output;
      if (Array.isArray(entry.reasoning_options)) {
        const offered = entry.reasoning_options.flatMap((option) => {
          const item = object(option); return item.type === 'effort' && Array.isArray(item.values) ? item.values : [];
        });
        metadata.reasoningEfforts = efforts.filter((effort) => offered.includes(effort));
      }
      if (Object.keys(metadata).length) models[id.toLowerCase()] = metadata;
    }
    if (Object.keys(models).length) catalog[vendor] = models;
  }
  return catalog;
}

export function matchModelCatalog(provider: ProviderApiKind, id: string, catalog: ModelCatalog = MODEL_CATALOG_SNAPSHOT): { values: Partial<ModelMetadata>; match: 'exact' | 'alias' } | undefined {
  if (!id || id === '__proto__' || id === 'constructor') return;
  const allowed = provider === 'gemini' ? ['google'] : provider === 'anthropic' ? ['anthropic', 'minimax', 'deepseek'] : CATALOG_VENDORS;
  const normalized = id.toLowerCase();
  for (const vendor of allowed) {
    const models = catalog[vendor];
    if (models && Object.hasOwn(models, normalized)) return { values: { ...models[normalized] }, match: 'exact' };
  }
  // Gateways and fine-tunes often wrap an original ID. Aliases inherit flags only,
  // since their deployment may have different context/output limits or controls.
  const candidates = [normalized, normalized.replace(/^ft:/, '').split(':')[0], normalized.split('/').at(-1)!];
  let best: { id: string; values: Partial<ModelMetadata> } | undefined;
  for (const vendor of allowed) for (const [key, values] of Object.entries(catalog[vendor] ?? {})) {
    if (candidates.some((candidate) => candidate === key || candidate.startsWith(`${key}-`) || candidate.startsWith(`${key}:`)) && (!best || key.length > best.id.length)) best = { id: key, values };
  }
  if (!best) return;
  const values: Partial<ModelMetadata> = {};
  for (const field of ['imageInput', 'toolCalls', 'structuredOutput', 'reasoning'] as const) if (best.values[field] !== undefined) values[field] = best.values[field];
  // A reasoning family name cannot establish the wire parameters of a new alias.
  if (/(?:^|\/)gpt-.*[.-]chat(?:[.-]|$)/.test(normalized)) values.reasoning = false;
  return { values, match: 'alias' };
}

export function enrichModelCatalog<T extends ProviderModel>(provider: ProviderApiKind, model: T, catalog: ModelCatalog, updatedAt: number): T {
  if ((model.directoryMetadata?.updatedAt ?? 0) > updatedAt) return model;
  const found = matchModelCatalog(provider, model.id, catalog);
  if (!found) return model;
  const directoryMetadata = { ...found, updatedAt };
  return JSON.stringify(model.directoryMetadata) === JSON.stringify(directoryMetadata) ? model : { ...model, directoryMetadata };
}
