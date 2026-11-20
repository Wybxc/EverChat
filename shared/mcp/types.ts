export interface McpKeyInfo {
  id: string;
  name: string;
  keyHint: string;
  createdAt: number;
  lastUsedAt: number | null;
  readSystemPrompts: boolean;
}
export interface McpOAuthConnection {
  id: string;
  name: string;
  redirectOrigin: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}
