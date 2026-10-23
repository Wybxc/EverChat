import type { Conversation } from '../conversation/durable-object';
import type { Library } from '../library/durable-object';
import type { ToolWorkflowParams } from '../web-tools/workflow';
import type { UsageStore } from '../usage/durable-object';
import type { ShareStore } from '../sharing/durable-object';

export interface Env {
  ASSETS: Fetcher;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  LIBRARY: DurableObjectNamespace<Library>;
  USAGE?: DurableObjectNamespace<UsageStore>;
  SHARES?: DurableObjectNamespace<ShareStore>;
  SHARE_LINK_KEY?: string;
  WEB_TOOLS: Workflow<ToolWorkflowParams>;
  ATTACHMENTS?: R2Bucket;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  APP_ORIGIN?: string;
  MCP_ALLOWED_MODELS?: string;
  MCP_DEFAULT_MODEL?: string;
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
