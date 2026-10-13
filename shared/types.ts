export type MessageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: number;
  runId: string | null;
  parentId: string | null;
  revisionOf: string | null;
  error: string | null;
  reasoning?: string | null;
  providerId?: string | null;
  model?: string | null;
  modelName?: string | null;
}
export interface ConversationInfo { id: string; title: string; createdAt: number; updatedAt: number }
export interface Snapshot { messages: Message[]; seq: number }
export interface Change { type: 'change'; seq: number; messages: Message[] }
export type SyncPacket = Change | { type: 'snapshot'; snapshot: Snapshot } | { type: 'ready'; seq: number };
export interface ModelSelection { providerId: string; model: string }
export interface SubmitInput { requestId: string; content?: string; retryOf?: string; revisionOf?: string; selection?: ModelSelection; showReasoning?: boolean; reasoningEffort?: ReasoningEffort }
export interface Submission { runId: string; userId: string; assistantId: string }
export interface GenerationParams { conversationId: string; runId: string }
export interface ChatInput { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatModel extends ModelSelection { name: string; providerName: string; reasoningSupported: boolean; reasoningEfforts: ReasoningEffort[] }
export interface SessionInfo { authenticated: boolean; provider: string; model: string; modelName?: string; activeProviderId?: string | null; models?: ChatModel[]; configured: boolean; showReasoning?: boolean; systemPrompt?: string; maxOutputTokens?: number }

export type ProviderKind = 'openai-chat' | 'anthropic' | 'openai-responses' | 'gemini';
export type ProviderApiKind = ProviderKind;
export interface ProviderConfig {
  provider: ProviderApiKind;
  baseUrl: string;
  model: string;
  modelName?: string;
  systemPrompt: string;
  maxOutputTokens: number;
  apiKey?: string;
  providerId?: string;
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  showReasoning?: boolean;
}
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ProviderModel {
  id: string; name: string; enabled: boolean;
  useGlobalSystemPrompt?: boolean;
  systemPrompt?: string;
  reasoningSupport?: 'auto' | 'supported' | 'unsupported';
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
  providers: ProviderProfile[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number;
  showReasoning: boolean;
}
export interface ProviderSettingsInput {
  providers: ProviderProfileInput[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number;
  showReasoning: boolean;
}
export interface ProviderModelConfig extends Omit<ProviderProfile, 'hasApiKey'> {
  apiKey?: string;
}
export const isActive = (message: Message) => message.status === 'queued' || message.status === 'running';

export function applyChange(snapshot: Snapshot, change: Change): Snapshot {
  if (change.seq <= snapshot.seq) return snapshot;
  if (change.seq !== snapshot.seq + 1) throw new Error('Sync sequence gap');
  const messages = [...snapshot.messages];
  for (const message of change.messages) {
    const index = messages.findIndex((existing) => existing.id === message.id);
    if (index === -1) messages.push(message);
    else messages[index] = message;
  }
  return { messages, seq: change.seq };
}
