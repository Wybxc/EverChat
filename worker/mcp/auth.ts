import type { Env } from '../http/env';
import { HttpError } from '../http/response';
import type { McpPrincipal } from './keys';

export async function authenticateMcp(request: Request, env: Env): Promise<McpPrincipal> {
  const match = /^Bearer (ec_mcp_[A-Za-z0-9_-]+)$/i.exec(
    request.headers.get('Authorization') ?? '',
  );
  const principal = match
    ? await env.LIBRARY.getByName('personal').mcpAuthenticate(match[1])
    : null;
  if (!principal)
    throw new HttpError(401, 'A valid EverChat MCP API key is required.', 'MCP_AUTH_REQUIRED');
  return principal;
}
