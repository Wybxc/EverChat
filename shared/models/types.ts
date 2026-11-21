import type { ProviderApiKind } from '../providers/types';
import type { ReportedServerTools, TestedServerTools } from '../tools/server-tools';
export interface ModelSelection {
  providerId: string;
  model: string;
}

export interface ChatModel extends ModelSelection {
  name: string;
  providerName: string;
  provider: ProviderApiKind;
  baseUrl: string;
  systemPrompt?: string;
  reasoningSupported: boolean;
  reasoningEfforts: ReasoningEffort[];
  metadata: ResolvedModelMetadata;
  reportedServerTools?: ReportedServerTools;
  testedServerTools?: TestedServerTools;
}

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

export type MetadataSource =
  'manual' | 'provider' | 'tested' | 'catalog' | 'directory' | 'inferred' | 'fallback';

export interface ResolvedModelMetadata extends ModelMetadata {
  sources: Record<keyof ModelMetadata, MetadataSource>;
}

export type ModelMetadataOverrides = Partial<Omit<ModelMetadata, 'reasoning'>>;

export interface DiscoveredModel {
  id: string;
  name: string;
  reportedMetadata?: ReportedModelMetadata;
}

export type ReportedModelMetadata = Partial<ModelMetadata> & { serverTools?: ReportedServerTools };

export interface ProviderModel {
  id: string;
  name: string;
  enabled: boolean;
  useGlobalSystemPrompt?: boolean;
  systemPrompt?: string;
  reasoningSupport?: 'auto' | 'supported' | 'unsupported';
  reportedMetadata?: ReportedModelMetadata;
  directoryMetadata?: {
    values: Partial<ModelMetadata>;
    match: 'exact' | 'alias';
    updatedAt: number;
  };
  testedCapabilities?: { imageInput?: true; toolCalls?: true; testedAt: number };
  testedServerTools?: TestedServerTools;
  metadataOverrides?: ModelMetadataOverrides;
}
