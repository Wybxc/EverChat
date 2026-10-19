import type { Conversation } from '../conversation/durable-object';
import type { Library } from '../library/durable-object';
import type { ToolWorkflowParams } from '../web-tools/workflow';
import type { UsageStore } from '../usage/durable-object';

export interface Env {
  ASSETS: Fetcher;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  LIBRARY: DurableObjectNamespace<Library>;
  USAGE?: DurableObjectNamespace<UsageStore>;
  WEB_TOOLS: Workflow<ToolWorkflowParams>;
  ATTACHMENTS?: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  APP_ORIGIN?: string;
  AI_API_KEY?: string;
  AI_PROVIDER: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  SYSTEM_PROMPT: string;
  MAX_OUTPUT_TOKENS?: string;
  GENERATION_METRICS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
