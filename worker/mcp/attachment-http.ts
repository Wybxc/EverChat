import { authenticateMcp } from './auth';
import type { Env } from '../http/env';
import { json, HttpError } from '../http/response';

export async function serveMcpAttachment(request: Request, env: Env) {
  const url = new URL(request.url),
    match = /^\/mcp\/attachments\/([^/]+)$/.exec(url.pathname);
  if (!match || !['GET', 'HEAD'].includes(request.method))
    return json({ error: 'Not found.' }, 404);
  if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
    return json({ error: 'Cross-origin file requests are not allowed.' }, 403);
  try {
    const principal = await authenticateMcp(request, env);
    return env.LIBRARY.getByName('personal').mcpFileResponse(
      principal.keyId,
      match[1],
      request.method === 'HEAD',
    );
  } catch (error) {
    return json(
      { error: error instanceof HttpError ? error.message : 'File unavailable.' },
      error instanceof HttpError ? error.status : 503,
    );
  }
}
