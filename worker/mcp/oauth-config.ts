import type { Env } from '../http/env';

export const mcpOAuthScope = 'mcp:use';
export const mcpAuthorizePath = '/auth/mcp/authorize';
export const mcpTokenPath = '/mcp/oauth/token';
export const mcpResourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';
export const mcpAuthorizationMetadataPath = '/.well-known/oauth-authorization-server';

export function isLoopback(hostname: string) {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';
}

export function mcpOAuthConfig(env: Env) {
  if (env.MCP_OAUTH_ENABLED === '0' || !env.APP_ORIGIN) return null;
  const url = URL.parse(env.APP_ORIGIN);
  if (
    !url ||
    url.origin !== env.APP_ORIGIN ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
  )
    return null;
  return {
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    metadata: `${url.origin}${mcpResourceMetadataPath}`,
    secure: url.protocol === 'https:',
  };
}
