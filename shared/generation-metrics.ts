import type { GenerationExecutor, MessageStatus } from './types';

export interface StreamCounts { textDeltas: number; reasoningDeltas: number }

// Application counters complement Cloudflare's CPU/duration metrics; they are not a bill.
export interface GenerationMeasurements extends StreamCounts {
  runId: string;
  executor?: GenerationExecutor;
  coverage: 'claim-to-terminal' | 'since-last-resume';
  status: MessageStatus;
  elapsedMs: number;
  checkpoints: number;
  checkpointBytes: number;
  sqlStatements: number;
  sqlRowsRead: number;
  sqlRowsWritten: number;
  eventPayloadBytes: number;
  broadcastFrames: number;
  broadcastBytes: number;
  databaseBytes: number;
  contentCharacters: number;
  reasoningCharacters: number;
}
