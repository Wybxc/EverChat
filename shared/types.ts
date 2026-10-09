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
}
export interface ConversationInfo { id: string; title: string; createdAt: number; updatedAt: number }
export interface Snapshot { messages: Message[]; seq: number }
export interface Change { type: 'change'; seq: number; messages: Message[] }
export type SyncPacket = Change | { type: 'snapshot'; snapshot: Snapshot } | { type: 'ready'; seq: number };
export interface SubmitInput { requestId: string; content?: string; retryOf?: string; revisionOf?: string }
export interface Submission { runId: string; userId: string; assistantId: string }
export interface GenerationParams { conversationId: string; runId: string }
export interface ChatInput { role: 'system' | 'user' | 'assistant'; content: string }
export interface SessionInfo { authenticated: boolean; provider: string; model: string; configured: boolean }

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
