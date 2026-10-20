import type { Message, ConversationSettings } from '../conversation/types';
import type { ConversationActivity } from '../conversation/activity';
export interface Snapshot {
  epoch?: string;
  activity?: ConversationActivity;
  messages: Message[];
  seq: number;
  deletedAt?: number;
  settings?: ConversationSettings;
}

export interface SnapshotPage {
  snapshot: Snapshot;
  after: number;
  done: boolean;
}

export interface Change {
  activity?: ConversationActivity;
  type: 'change';
  seq: number;
  messages: Message[];
  settings?: ConversationSettings;
}

export interface StreamBatch {
  version: 'events-v1';
  runId: string;
  messageId: string;
  chunkSeq: number;
  startOffset: number;
  endOffset: number;
  data: string;
}

export interface StreamCommit {
  runId: string;
  messageId: string;
  batches: StreamBatch[];
}

export interface Commit extends StreamCommit {
  type: 'commit';
  seq: number;
}

export interface CommitAck {
  type: 'commit-ack';
  seq: number;
  runId: string;
  messageId: string;
  firstChunkSeq: number;
  lastChunkSeq: number;
  startOffset: number;
  endOffset: number;
}

interface Preview {
  type: 'preview';
  batch: StreamBatch;
}

export type DurableChange = Change | Commit;

export type SyncPacket =
  | DurableChange
  | Preview
  | CommitAck
  | { type: 'resync' }
  | { type: 'state'; after: number; snapshot: Snapshot }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ready'; seq: number }
  | { type: 'deleted'; deletedAt: number };

export type GenerationExecutor = 'do-v1';
