import type { McpFailure } from './contracts';

export interface McpPrincipal {
  id: string;
}

export const oauthPrincipalPrefix = 'oauth:';

export function mcpRevoked(principal: string): McpFailure {
  const oauth = principal.startsWith(oauthPrincipalPrefix);
  return {
    code: oauth ? 'MCP_GRANT_REVOKED' : 'MCP_KEY_REVOKED',
    message: oauth ? 'This OAuth authorization is no longer active.' : 'This API key was revoked.',
    stage: 'authorization',
    retryable: false,
  };
}
