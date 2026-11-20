import { authenticateMcp, mcpHttpError } from './auth';
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
      principal.id,
      match[1],
      request.method === 'HEAD',
    );
  } catch (error) {
    if (error instanceof HttpError) return mcpHttpError(request, env, error);
    return json({ error: 'File unavailable.' }, 503);
  }
}
