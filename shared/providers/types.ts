import type { DocumentPart } from '../attachments/documents';
import type { ImagePart } from '../attachments/images';
import type { WebToolServiceConfig } from '../web-tools/service';
import type { TitleSettings } from '../conversation/titles';
import type {
  ChatModel,
  ProviderModel,
  ReasoningEffort,
  ResolvedModelMetadata,
} from '../models/types';
export interface ChatInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: ImagePart[];
  files?: DocumentPart[];
  /** Application provenance only. Provider adapters never serialize this field. */
  source?: { kind: 'message' | 'summary' | 'generated'; messageId?: string };
}

export interface SessionSettings {
  titleModelConfigured?: boolean;
  provider: string;
  model: string;
  modelName?: string;
  activeProviderId?: string | null;
  providerNames?: Record<string, string>;
  models?: ChatModel[];
  attachmentsConfigured: boolean;
  systemPrompt?: string;
  maxOutputTokens?: number | null;
}

export type ProviderKind = 'openai-chat' | 'anthropic' | 'openai-responses' | 'gemini';

export type ProviderApiKind = ProviderKind;

export interface ProviderConfig {
  provider: ProviderApiKind;
  baseUrl: string;
  model: string;
  modelName?: string;
  systemPrompt: string;
  maxOutputTokens: number | null;
  temperature?: number;
  topP?: number;
  apiKey?: string;
  providerId?: string;
  providerName?: string;
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  modelMetadata?: ResolvedModelMetadata;
  webTools?: WebToolServiceConfig;
}

export interface ProviderProfile {
  id: string;
  name: string;
  provider: ProviderApiKind;
  baseUrl: string;
  models: ProviderModel[];
  hasApiKey: boolean;
  apiKey?: string;
}

export interface ProviderProfileInput extends Omit<ProviderProfile, 'hasApiKey'> {
  apiKey?: string;
}

export interface ProviderSettings {
  title?: TitleSettings;
  providers: ProviderProfile[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number | null;
}

export interface ProviderSettingsInput {
  title?: TitleSettings;
  providers: ProviderProfileInput[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number | null;
}

export interface ProviderModelConfig extends Omit<ProviderProfile, 'hasApiKey'> {
  apiKey?: string;
}
