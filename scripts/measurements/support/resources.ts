// Local diagnostic counters. Neither elapsed time nor these operation counts are
// Cloudflare CPU, billed requests, Workflow storage, or account usage.
export interface ToolResourceWindow {
  windowId: string;
  instanceId: string;
  elapsedMs: number;
  sql: Record<string, { statements: number; rowsRead: number; rowsWritten: number }>;
  streams: Record<
    'public' | 'private',
    { commits: number; wireBytes: number; payloadBytes: number }
  >;
  eventPayloadBytes: number;
  broadcasts: { frames: number; bytes: number };
  alarms: { set: number; delete: number };
  upstream: {
    modelRequests: number;
    modelBytes: number;
    toolRequests: number;
    toolResponseBytes: number;
  };
}
export interface ToolWorkflowMeasurements {
  steps: { name: string; attempts: number; failures: number; resultBytes: number }[];
  waits: { name: string; resultBytes: number }[];
}
