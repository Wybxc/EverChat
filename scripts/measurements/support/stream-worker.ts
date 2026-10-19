// Isolated platform validation entry point. Never route a model call to a real supplier.
import { Conversation as FixtureConversation } from '../../../tests/support/runtime/conversation';
import { Library as ProductionLibrary } from '../../../tests/support/runtime/library';
import { createTestWorker } from '../../../tests/support/runtime/control-routes';
import { installMockUpstream } from '../../../tests/support/providers/upstream';
import type { Authenticator } from '../../../worker/http/auth';
import { authenticateValidation } from './access';
import type { Env } from '../../../worker/http/env';
export { WebToolWorkflow } from '../../../worker/web-tools/workflow';
export { UsageStore } from '../../../worker/usage/durable-object';
export { ShareStore } from '../../../worker/sharing/durable-object';
export class Conversation extends FixtureConversation {
  validationStorageBytes() {
    return this.ctx.storage.sql.databaseSize;
  }
}
export class Library extends ProductionLibrary {
  validationStorageBytes() {
    return this.ctx.storage.sql.databaseSize;
  }
}
installMockUpstream();
const mockFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.hostname !== 'provider.test' &&
    !(url.hostname.endsWith('.cloudflareaccess.com') && url.pathname === '/cdn-cgi/access/certs')
  )
    return new Response('External supplier disabled', { status: 502 });
  return mockFetch(input, init);
};
export function createStreamWorker(authenticate: Authenticator = authenticateValidation) {
  const fixture = createTestWorker(authenticate);
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/__validation/storage' && request.method === 'GET') {
        try {
          await authenticate(request, env);
        } catch {
          return new Response('Unauthorized', { status: 401 });
        }
        const library = (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName(
          'personal',
        );
        const conversations = await library.list();
        const sizes = await Promise.all(
          conversations.map(({ id }) =>
            (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>)
              .getByName(id)
              .validationStorageBytes(),
          ),
        );
        return Response.json({
          sampledAt: new Date().toISOString(),
          libraryBytes: await library.validationStorageBytes(),
          conversationBytes: sizes,
          scope:
            'Post-run SQLite database allocation from deployed objects. Not a platform billing total or the peak during streaming.',
        });
      }
      return pathname.startsWith('/api/')
        ? fixture.fetch(request, env, ctx)
        : new Response('Not found', { status: 404 });
    },
  } satisfies ExportedHandler<Env>;
}
export default createStreamWorker();
