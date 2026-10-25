export interface McpKeyInfo {
  id: string;
  name: string;
  keyHint: string;
  createdAt: number;
  lastUsedAt: number | null;
  readSystemPrompts: boolean;
}
