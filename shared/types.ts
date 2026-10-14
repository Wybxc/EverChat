import type { DocumentPart } from './documents';
import { ProviderStream, type StreamState } from './provider-stream';
import type { GenerationResult } from './generation';
import type { SummaryCoverage } from './summaries';
import { validateBatch, validateCommit } from './stream-batches';
import { messageParts, messageText, type MessagePart } from './message-content';
import type { ImagePart } from './images';
export type { MessagePart } from './message-content';

export type MessageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  status: MessageStatus;
  createdAt: number;
  runId: string | null;
  parentId: string | null;
  revisionOf: string | null;
  deletedAt?: number | null;
  error: string | null;
  providerId?: string | null;
  model?: string | null;
  modelName?: string | null;
  streamVersion?: 'raw-sse-v1' | null;
  streamState?: StreamState;
  generation?: GenerationResult;
  summary?: SummaryCoverage;
  waitingForSummary?: string;
  durableOffset?: number;
  liveOffset?: number;
}
export interface ConversationInfo { id: string; title: string; createdAt: number; updatedAt: number; pinned: boolean; archived: boolean }
export interface LibrarySnapshot { conversations: ConversationInfo[]; deletions: { id: string; deletedAt: number }[]; deletionCursor: number; hasMoreDeletions: boolean }
export interface ConversationSettings {
  systemPrompt: string | null; temperature: number | null; topP: number | null;
  useGlobalMaxOutputTokens: boolean; maxOutputTokens: number | null;
  recentMessages: number | null; contextBudget: number | null;
  useSummaries: boolean;
  autoCompression: { enabled: boolean; threshold: number; model: ModelSelection | null };
}
export interface PromptPreset { id: string; name: string; systemPrompt: string; updatedAt: number }
export type PromptPresetInput = Pick<PromptPreset, 'name' | 'systemPrompt'>;
export interface Snapshot { messages: Message[]; seq: number; deletedAt?: number; settings?: ConversationSettings }
export interface Change { type: 'change'; seq: number; messages: Message[]; settings?: ConversationSettings }
export interface StreamBatch {
  version: 'raw-sse-v1'; runId: string; messageId: string; chunkSeq: number;
  startOffset: number; endOffset: number; data: string;
}
export interface StreamCommit { runId: string; messageId: string; batches: StreamBatch[] }
export interface Commit extends StreamCommit { type: 'commit'; seq: number }
export interface CommitAck {
  type: 'commit-ack'; seq: number; runId: string; messageId: string;
  firstChunkSeq: number; lastChunkSeq: number; startOffset: number; endOffset: number;
}
export interface Preview { type: 'preview'; batch: StreamBatch }
export type DurableChange = Change | Commit;
export type SyncPacket = DurableChange | Preview | CommitAck | { type: 'snapshot'; snapshot: Snapshot } | { type: 'ready'; seq: number } | { type: 'deleted'; deletedAt: number };
export interface ModelSelection { providerId: string; model: string }
export interface SubmitInput { requestId: string; content?: string; imageIds?: string[]; fileIds?: string[]; retryOf?: string; revisionOf?: string; branchHead?: string; summaryThrough?: string; selection?: ModelSelection; showReasoning?: boolean; reasoningEffort?: ReasoningEffort; settings?: ConversationSettings }
export interface Submission { runId: string; userId: string; assistantId: string; summaryId?: string }
export type GenerationExecutor = 'do-v1';
export interface ChatInput { role: 'system' | 'user' | 'assistant'; content: string; images?: ImagePart[]; files?: DocumentPart[] }
export interface ChatModel extends ModelSelection { name: string; providerName: string; provider: ProviderApiKind; baseUrl: string; systemPrompt?: string; reasoningSupported: boolean; reasoningEfforts: ReasoningEffort[]; metadata: ResolvedModelMetadata }
export interface SessionInfo { authenticated: boolean; provider: string; model: string; modelName?: string; activeProviderId?: string | null; models?: ChatModel[]; configured: boolean; attachmentsConfigured: boolean; showReasoning?: boolean; systemPrompt?: string; maxOutputTokens?: number | null }

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
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  showReasoning?: boolean;
  modelMetadata?: ResolvedModelMetadata;
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
export type MetadataSource = 'manual' | 'provider' | 'catalog' | 'fallback';
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
  metadataOverrides?: ModelMetadataOverrides;
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
  maxOutputTokens: number | null;
  showReasoning: boolean;
}
export interface ProviderSettingsInput {
  providers: ProviderProfileInput[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number | null;
  showReasoning: boolean;
}
export interface ProviderModelConfig extends Omit<ProviderProfile, 'hasApiKey'> {
  apiKey?: string;
}
export const isActive = (message: Pick<Message, 'status'>) => message.status === 'queued' || message.status === 'running';

/** Return the chronological message path that leads to a selected branch head. */
export function branchPath(messages: Message[], headId: string): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let current = byId.get(headId);
  if (!current) throw new Error('消息分支不存在。');
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    if (current.parentId && !byId.has(current.parentId)) throw new Error('消息分支的父消息不存在。');
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (current) throw new Error('消息分支存在循环。');
  return path.reverse();
}

export function applyChange(snapshot: Snapshot, change: DurableChange): Snapshot {
  if (change.seq <= snapshot.seq) return snapshot;
  if (change.seq !== snapshot.seq + 1) throw new Error('Sync sequence gap');
  const messages = [...snapshot.messages];
  if (change.type === 'commit') {
    const index = messages.findIndex((message) => message.id === change.messageId);
    if (index === -1) throw new Error('Missing streamed message');
    validateCommit(change);
    for (const batch of change.batches) messages[index] = appendMessage(messages[index], batch);
    return { ...snapshot, messages, seq: change.seq };
  }
  for (const message of change.messages) {
    const index = messages.findIndex((existing) => existing.id === message.id);
    if (index === -1) messages.push(message);
    else messages[index] = message;
  }
  return { ...snapshot, messages, seq: change.seq, ...(change.settings ? { settings: change.settings } : {}) };
}

export function appendMessage(message: Message, batch: StreamBatch): Message {
  const bytes = validateBatch(batch);
  if (message.streamVersion !== batch.version || message.role !== 'assistant'
    || message.id !== batch.messageId || message.runId !== batch.runId || !message.streamState) throw new Error('Stream identity mismatch');
  if (message.status !== 'running') throw new Error('Streamed message is not running');
  if (batch.startOffset !== (message.durableOffset ?? 0)) throw new Error('Stream offset gap');
  const state = message.streamState;
  const parser = new ProviderStream(state.protocol, state.showReasoning, state, messageText(message), messageText(message, 'reasoning'));
  parser.feed(bytes);
  return { ...message, parts: messageParts(parser.content, parser.reasoning), streamState: parser.checkpoint(), durableOffset: batch.endOffset };
}
