import { app } from './http/app';
import type { Env } from './http/env';
export { Conversation } from './conversation/durable-object';
export { Library } from './library/durable-object';
export { WebToolWorkflow } from './web-tools/workflow';

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<Env>;
