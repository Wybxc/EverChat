// Optional expiry reuses the existing column and alarm cleanup; no schema migration
// or snapshot rewriting is performed at application startup.
export const SHARING_SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, operationId TEXT UNIQUE NOT NULL, conversationId TEXT NOT NULL,
  headId TEXT NOT NULL, sourceVersion TEXT NOT NULL, createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL, draftUntil INTEGER NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, includeReasoning INTEGER NOT NULL, messageCount INTEGER NOT NULL,
  blockCount INTEGER NOT NULL, omittedAttachments INTEGER NOT NULL, hash TEXT NOT NULL,
  tokenHash TEXT, tokenCipher TEXT, expiresAt INTEGER
);
CREATE INDEX IF NOT EXISTS shares_conversation ON shares(conversationId, status);
CREATE INDEX IF NOT EXISTS shares_created ON shares(createdAt, id);
CREATE TABLE IF NOT EXISTS share_blocks (
  shareId TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(shareId, seq)
);
CREATE TABLE IF NOT EXISTS share_deletions (conversationId TEXT PRIMARY KEY);
`;
