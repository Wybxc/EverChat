export const MCP_REQUESTS_SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_requests (
  principal TEXT NOT NULL, requestId TEXT NOT NULL, fingerprint TEXT NOT NULL,
  conversationId TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(principal, requestId)
) WITHOUT ROWID`;
