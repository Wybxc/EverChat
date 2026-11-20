import type { Env } from '../http/env';
import { HttpError, json } from '../http/response';
import { mcpOAuthConfig, mcpOAuthScope } from './oauth-config';
import { isOAuthAccessToken } from './oauth-store';
import type { McpPrincipal } from './principal';

const bearer = (request: Request) =>
  /^Bearer ([^\s,]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];

export async function authenticateMcp(request: Request, env: Env): Promise<McpPrincipal> {
  const token = bearer(request);
  const library = env.LIBRARY.getByName('personal');
  const config = mcpOAuthConfig(env);
  if (token?.startsWith('ec_mcp_')) {
    const principal = await library.mcpAuthenticate(token);
    if (principal) return principal;
  } else if (config && token && isOAuthAccessToken(token)) {
    const principal = await library.mcpOAuthAuthenticate(token);
    if (principal) return principal;
  }
  throw new HttpError(
    401,
    config
      ? 'A valid EverChat MCP credential is required.'
      : 'A valid EverChat MCP API key is required.',
    'MCP_AUTH_REQUIRED',
  );
}

export function mcpHttpError(request: Request, env: Env, error: HttpError) {
  let challenge = 'Bearer realm="EverChat MCP"';
  const config = mcpOAuthConfig(env);
  if (config) {
    challenge += `, resource_metadata="${config.metadata}", scope="${mcpOAuthScope}"`;
    if (bearer(request)) challenge += ', error="invalid_token"';
  }
  return json(
    { error: error.message, code: error.code },
    error.status,
    error.status === 401 ? { 'WWW-Authenticate': challenge } : undefined,
  );
}
