import type { MessagePart } from './content';
import type { StreamState } from '../streaming/provider-stream';
import type { GenerationResult } from '../streaming/generation';
import type { SummaryCoverage } from './summaries';
import type { PublicToolTask, WebToolName } from '../tools/tasks';
import type { ModelSelection, ReasoningEffort } from '../models/types';
import type { ActivityIndex, ConversationActivity } from './activity';
import type { TitleSource, TitleTaskInfo } from './titles';
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
  streamVersion?: 'events-v1' | null;
  streamState?: StreamState;
  generation?: GenerationResult;
  summary?: SummaryCoverage;
  waitingForSummary?: string;
  durableOffset?: number;
  liveOffset?: number;
  tools?: PublicToolTask;
  continuation?: AnswerContinuation;
}

/** Immutable execution provenance; lengths address the composed UTF-16 channels. */
export interface AnswerStage {
  id: string;
  status: MessageStatus;
  createdAt: number;
  contentLength: number;
  reasoningLength: number;
  providerId?: string | null;
  model?: string | null;
  modelName?: string | null;
  generation?: GenerationResult;
  tools?: PublicToolTask;
}
export interface AnswerContinuation {
  sourceId: string;
  sourceTextSha256: string;
  prefixTextLength: number;
  prefixReasoningLength: number;
  stages: AnswerStage[];
  /** Portable copies store the complete channels with self-contained provenance. */
  detached?: true;
}

export interface ConversationInfo {
  titleSource?: TitleSource;
  titleTask?: TitleTaskInfo;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

export interface LibrarySnapshot {
  conversations: ConversationInfo[];
  activity: ActivityIndex;
  deletions: { id: string; deletedAt: number }[];
  deletionCursor: number;
  hasMoreDeletions: boolean;
}

export interface ConversationSettings {
  systemPrompt: string | null;
  temperature: number | null;
  topP: number | null;
  useGlobalMaxOutputTokens: boolean;
  maxOutputTokens: number | null;
  recentMessages: number | null;
  contextBudget: number | null;
  tools: WebToolName[];
  autoCompression: { enabled: boolean; threshold: number; model: ModelSelection | null };
}

export interface SubmitInput {
  requestId: string;
  content?: string;
  imageIds?: string[];
  fileIds?: string[];
  fileInputModes?: Record<string, 'auto' | 'inline' | 'on_demand'>;
  fileSelections?: Record<string, import('../attachments/documents').DocumentRange[]>;
  materialBindings?: Record<string, import('../attachments/materials').MaterialBinding>;
  retryOf?: string;
  continueOf?: string;
  sourceTextSha256?: string;
  revisionOf?: string;
  parentId?: string | null;
  summaryThrough?: string;
  selection?: ModelSelection;
  reasoningEffort?: ReasoningEffort;
  settings?: ConversationSettings;
  tools?: WebToolName[];
}

export interface Submission {
  runId: string;
  userId: string;
  assistantId: string;
  summaryId?: string;
  activity?: ConversationActivity;
}
