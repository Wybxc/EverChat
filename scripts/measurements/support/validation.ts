// Sanitized, read-only validation data. No model inputs, outputs, keys or private turns.
export const TOOL_VALIDATION_WORKER = 'everchat-tools-validation';
export interface ToolValidationIdentity {
  kind: typeof TOOL_VALIDATION_WORKER;
  version: 1;
  runId: string;
  mockUpstreams: true;
  counters: { generation: boolean; local: boolean };
  workload: { chunks: number; size: number; interval: number };
}
export interface ToolValidationConversation {
  databaseBytes: number; alarmAt: number | null;
  pendingSearch: number; pendingNotifications: number;
  privateStreams: number; privatePayloads: number; retainedContexts: number;
  modelCalls: number; serviceRequests: number;
  task: { status: string; round: number; modelRequests: number; toolRequests: number } | null;
  workflowStatus: string | null;
}
export interface ToolValidationLibrary {
  databaseBytes: number; alarmAt: number | null; pendingBackfills: number; usedToday: number;
}
