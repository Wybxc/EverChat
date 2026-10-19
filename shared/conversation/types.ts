import type { MessagePart } from './content';
import type { StreamState } from '../streaming/provider-stream';
import type { GenerationResult } from '../streaming/generation';
import type { SummaryCoverage } from './summaries';
import type { PublicToolTask, WebToolName } from '../web-tools/tasks';
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
  streamVersion?: 'raw-sse-v1' | null;
  streamState?: StreamState;
  generation?: GenerationResult;
  summary?: SummaryCoverage;
  waitingForSummary?: string;
  durableOffset?: number;
  liveOffset?: number;
  tools?: PublicToolTask;
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
  useSummaries: boolean;
  tools: WebToolName[];
  autoCompression: { enabled: boolean; threshold: number; model: ModelSelection | null };
}

export interface SubmitInput {
  requestId: string;
  content?: string;
  imageIds?: string[];
  fileIds?: string[];
  fileSelections?: Record<string, import('../attachments/documents').DocumentRange[]>;
  retryOf?: string;
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
