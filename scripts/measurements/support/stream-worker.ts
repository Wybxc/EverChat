// Isolated platform validation entry point. Never route a model call to a real supplier.
import fixture, { Conversation as FixtureConversation, Library as ProductionLibrary } from '../../../tests/support/runtime/worker';
import { authenticated } from '../../../worker/http/auth';
import type { Env } from '../../../worker/http/env';
export { WebToolWorkflow } from '../../../worker/web-tools/workflow';
export class Conversation extends FixtureConversation {
  validationStorageBytes() { return this.ctx.storage.sql.databaseSize; }
}
export class Library extends ProductionLibrary {
  validationStorageBytes() { return this.ctx.storage.sql.databaseSize; }
}
const mockFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'provider.test') return new Response('External supplier disabled', { status: 502 });
  return mockFetch(input, init);
};
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/__validation/storage' && request.method === 'GET') {
      if (!await authenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      const library = (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal');
      const conversations = await library.list();
      const sizes = await Promise.all(conversations.map(({ id }) => (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(id).validationStorageBytes()));
      return Response.json({ sampledAt: new Date().toISOString(), libraryBytes: await library.validationStorageBytes(), conversationBytes: sizes,
        scope: 'Post-run SQLite database allocation from deployed objects. Not a platform billing total or the peak during streaming.' });
    }
    return pathname.startsWith('/api/') ? fixture.fetch(request, env, ctx) : new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
