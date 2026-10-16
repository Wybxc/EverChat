import type { Conversation } from '../conversation/durable-object';
import type { Library } from '../library/durable-object';
import type { ToolWorkflowParams } from '../web-tools/workflow';

export interface Env {
  ASSETS: Fetcher;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  LIBRARY: DurableObjectNamespace<Library>;
  WEB_TOOLS: Workflow<ToolWorkflowParams>;
  ATTACHMENTS?: R2Bucket;
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  AI_API_KEY?: string;
  AI_PROVIDER: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  SYSTEM_PROMPT: string;
  MAX_OUTPUT_TOKENS?: string;
  GENERATION_METRICS?: string;
}
