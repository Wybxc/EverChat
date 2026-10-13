import type { Conversation } from './conversation';
import type { Library } from './library';
import type { GenerationParams } from '../shared/types';

export interface Env {
  ASSETS: Fetcher;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  LIBRARY: DurableObjectNamespace<Library>;
  GENERATION: Workflow<GenerationParams>;
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
