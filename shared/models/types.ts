import type { ProviderApiKind } from '../providers/types';
export interface ModelSelection { providerId: string; model: string }

export interface ChatModel extends ModelSelection { name: string; providerName: string; provider: ProviderApiKind; baseUrl: string; systemPrompt?: string; reasoningSupported: boolean; reasoningEfforts: ReasoningEffort[]; metadata: ResolvedModelMetadata }

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelMetadata {
  contextWindow: number;
  contextScope: 'combined' | 'input';
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalls: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  reasoningEfforts: ReasoningEffort[];
}

export type MetadataSource = 'manual' | 'provider' | 'tested' | 'catalog' | 'directory' | 'inferred' | 'fallback';

export interface ResolvedModelMetadata extends ModelMetadata {
  sources: Record<keyof ModelMetadata, MetadataSource>;
}

export type ModelMetadataOverrides = Partial<Omit<ModelMetadata, 'reasoning'>>;

export interface DiscoveredModel { id: string; name: string; reportedMetadata?: Partial<ModelMetadata> }

export interface ProviderModel {
  id: string; name: string; enabled: boolean;
  useGlobalSystemPrompt?: boolean;
  systemPrompt?: string;
  reasoningSupport?: 'auto' | 'supported' | 'unsupported';
  reportedMetadata?: Partial<ModelMetadata>;
  directoryMetadata?: { values: Partial<ModelMetadata>; match: 'exact' | 'alias'; updatedAt: number };
  testedCapabilities?: { imageInput?: true; toolCalls?: true; testedAt: number };
  metadataOverrides?: ModelMetadataOverrides;
}
